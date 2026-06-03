"""
Cross-document synthesis for search results.

Fast mode rehydrates the posted search results from Qdrant and produces a
grounded answer from canonical chunks.
Advanced mode first pulls multiple chunks per seed document, extracts
structured evidence per document, then synthesises across that evidence.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Generator, Literal, Sequence

from backend.services.hyde import generate_hypothesis
from backend.services.openai_client import get_openai_client
from backend.services.search import Searcher

logger = logging.getLogger(__name__)

SynthesisMode = Literal["fast", "advanced"]

_FAST_SYNTHESIS_SYSTEM_PROMPT = """\
أنت محلل بحثي أكاديمي متخصص مدمج في منصة المنظومة الأكاديمية.

[تعليمات داخلية — لا تُضمَّن في الإجابة]
- اعتمد فقط على المقتطفات المُسترجعة من قاعدة البيانات.
- اكتب `(م N)` مباشرةً بعد كل جملة موضوعية، حيث N رقم المستند من القائمة أدناه.
- استخرج كل ما له صلة حتى لو كان التطابق غير مباشر.
- لا تختلق أرقاماً أو نتائج — اقتصر على ما في المقتطفات.
- لا تُدرج قائمة مراجع أو أرقام المصادر في نهاية الإجابة.
- إن كانت المقتطفات غير كافية، صرّح بذلك بوضوح.
[نهاية التعليمات الداخلية]

اكتب إجابتك بالهيكل التالي حرفياً، دون أي إضافات قبله أو بعده:

### نظرة عامة موحدة
اربط المصادر المتاحة حول الموضوع: عدد الدراسات وطبيعتها وسياقها الأكاديمي العام. \
كل جملة موضوعية تنتهي بـ`(م N)`.

### المنهجيات والعينات
المناهج البحثية (وصفي/تجريبي/مسحي...)، أحجام العينات بالأرقام الدقيقة، أدوات الدراسة، \
الفروق المنهجية بين الدراسات. مرجع لكل معلومة.

### النتائج الرئيسية والإحصاءات
الأرقام والنسب والقيم الإحصائية المسحوبة مباشرةً من النصوص. \
قارن بين نتائج الدراسات. مرجع لكل رقم.

### التوافق والتعارض
أين تتفق المصادر وأين تختلف؟ عرض التعارضات صراحةً مع ذكر المصادر المتعارضة.

### فجوات البحث والتوصيات
ما أشارت إليه المصادر من حاجة للمزيد، وما لم تغطِّه المصادر المتاحة. \
اقترح محاور بحثية مستقبلية.

---
المقتطفات المُسترجعة:
{chunks}
"""

_ADVANCED_EVIDENCE_SYSTEM_PROMPT = """\
أنت أداة استخراج أدلة بحثية من مستند أكاديمي واحد.

أعد JSON صالحاً فقط، بلا Markdown، وبالمفاتيح التالية:
{{
  "doc_index": 1,
  "doc_id": "0000-000-000-000",
  "title": "عنوان المستند",
  "research_focus": "موضوع الدراسة الرئيسي",
  "methodology": "المنهج أو التصميم البحثي",
  "sample": "العينة أو البيانات أو المجتمع",
  "key_findings": [
    {{
      "claim": "نتيجة رئيسية موجزة",
      "evidence": "اقتباس حرفي قصير من المقاطع",
      "chunk_refs": [1, 2]
    }}
  ],
  "statistics": [
    {{
      "value": "رقم أو نسبة أو قيمة إحصائية",
      "context": "السياق الذي وردت فيه",
      "chunk_refs": [2]
    }}
  ],
  "limitations": ["قيد أو محدد"],
  "implications": ["دلالة أو توصية"],
  "evidence_quality": "high",
  "notes": "أي ملاحظة منهجية مهمة"
}}

قواعد:
- استخدم فقط المقاطع المسترجعة أدناه.
- لا تختلق أرقاماً أو عينات أو أدوات أو نتائج.
- إذا لم يرد شيء بوضوح فاجعل قيمته "غير مذكور".
- اجعل evidence اقتباساً حرفياً قصيراً من النص.
- chunk_refs يجب أن تشير إلى أرقام المقاطع داخل هذا المستند فقط.
- اكتب كل النص بالعربية.

المقاطع:
{chunks}
"""

_ADVANCED_FINAL_SYSTEM_PROMPT = """\
أنت محلل مراجعة أدبية أكاديمي متقدم يعمل داخل منصة المنظومة.

اعتمد فقط على كائنات JSON للأدلة البحثية الموضحة أدناه. لا تستخدم معرفة خارجية.

المطلوب:
- قدّم تحليلاً عميقاً لا مجرد تلخيص.
- قارن بين الدراسات من حيث التصميم والمنهجية والعينة والأدوات والنتائج.
- ميّز بين الاتفاق، التعارض، واتساق الدليل.
- اشرح قوة الأدلة وحدودها، ولاحظ إن كانت النتائج أولية أو قوية أو متضاربة.
- استخرج الفجوات البحثية والاتجاهات المستقبلية بناءً على ما ورد فعلاً.
- إذا كانت الأدلة غير كافية لنقطة معينة فقل ذلك صراحة.
- إذا كان السؤال بالإنجليزية فاكتب الإجابة بالإنجليزية، وإلا فاكتبها بالعربية.
- كل جملة موضوعية يجب أن تنتهي بـ`(م N)` حيث N رقم المستند كما ورد في الأدلة.

اكتب الإجابة بالهيكل التالي حرفياً:

### نظرة عامة بحثية
### المنهجيات والعينات
### النتائج والاتجاهات
### التوافق والتعارض
### فجوات البحث والتوصيات

الأدلة البحثية:
{evidence}
"""

_MAX_CHUNK_CHARS = 1500
_FAST_SOURCE_LIMIT = 10


def _safe_text(value: Any, limit: int | None = None) -> str:
    text = "" if value is None else str(value)
    text = text.strip()
    if limit is not None and len(text) > limit:
        return text[:limit] + "…"
    return text


def _merge_seed_with_canonical(
    seed: dict[str, Any],
    canonical: dict[str, Any] | None,
) -> dict[str, Any]:
    merged = dict(seed)
    if canonical:
        merged["text"] = canonical.get("text", seed.get("text", ""))
        merged["section"] = canonical.get("section", seed.get("section", ""))
        merged["title"] = canonical.get("title", seed.get("title", ""))
        merged["chunk_index"] = canonical.get("chunk_index", seed.get("chunk_index", 0))
        merged["char_len"] = canonical.get("char_len", seed.get("char_len", 0))
    return merged


def _seed_documents(seed_results: Sequence[dict[str, Any]], max_documents: int) -> list[dict[str, Any]]:
    """Keep the best seed result per document in search order."""
    seen: set[str] = set()
    docs: list[dict[str, Any]] = []
    for seed in seed_results:
        doc_id = _safe_text(seed.get("doc_id"))
        if not doc_id or doc_id in seen:
            continue
        seen.add(doc_id)
        docs.append(seed)
        if len(docs) >= max_documents:
            break
    return docs


def _section_bucket(section: str) -> str:
    normalized = _safe_text(section).replace("_", " ").lower()
    if not normalized:
        return "other"
    if any(term in normalized for term in ("المستخلص", "الملخص", "abstract")):
        return "abstract"
    if any(term in normalized for term in ("المقدمة", "مشكلة البحث", "أهداف البحث", "أهمية البحث", "introduction")):
        return "introduction"
    if any(term in normalized for term in ("الإطار النظري", "الدراسات السابقة", "theory")):
        return "theory"
    if any(term in normalized for term in ("منهج", "منهجية", "الاداة", "العينه", "method")):
        return "methods"
    if any(term in normalized for term in ("النتائج", "results")):
        return "results"
    if any(term in normalized for term in ("المناقشة", "discussion")):
        return "discussion"
    if any(term in normalized for term in ("الخاتمة", "الاستنتاج", "conclusion")):
        return "conclusion"
    if any(term in normalized for term in ("التوصيات", "recommend")):
        return "recommendations"
    return "other"


def _to_source_dict(item: Any) -> dict[str, Any]:
    if isinstance(item, dict):
        return {
            "chunk_id": _safe_text(item.get("chunk_id")),
            "doc_id": _safe_text(item.get("doc_id")),
            "text": _safe_text(item.get("text")),
            "title": _safe_text(item.get("title")),
            "section": _safe_text(item.get("section")),
            "score": float(item.get("score", 0.0) or 0.0),
            "chunk_index": int(item.get("chunk_index", 0) or 0),
            "journal_id": _safe_text(item.get("journal_id")),
            "char_len": int(item.get("char_len", 0) or 0),
        }

    return {
        "chunk_id": _safe_text(getattr(item, "chunk_id", "")),
        "doc_id": _safe_text(getattr(item, "doc_id", "")),
        "text": _safe_text(getattr(item, "text", "")),
        "title": _safe_text(getattr(item, "title", "")),
        "section": _safe_text(getattr(item, "section", "")),
        "score": float(getattr(item, "score", 0.0) or 0.0),
        "chunk_index": int(getattr(item, "chunk_index", 0) or 0),
        "journal_id": _safe_text(getattr(item, "journal_id", "")),
        "char_len": int(getattr(item, "char_len", 0) or 0),
    }


def _format_source_block(index: int, source: dict[str, Any]) -> str:
    title = _safe_text(source.get("title"), 80) or "Unknown"
    section = _safe_text(source.get("section"))
    chunk_index = source.get("chunk_index", 0)
    doc_id = _safe_text(source.get("doc_id"))
    chunk_id = _safe_text(source.get("chunk_id"))
    header = f"### م {index}: {title}"
    if section:
        header += f" — {section}"
    header += f" [doc_id={doc_id}; chunk_id={chunk_id}; chunk={chunk_index}]"

    text = _safe_text(source.get("text"), _MAX_CHUNK_CHARS)
    return f"{header}\n{text}\n"


def _stream_completion(
    client,
    *,
    messages: list[dict[str, str]],
    model: str,
    temperature: float,
    max_tokens: int,
) -> Generator[str, None, None]:
    stream = client.chat.completions.create(
        model=model,
        messages=messages,
        stream=True,
        temperature=temperature,
        max_tokens=max_tokens,
    )
    for chunk_resp in stream:
        delta = chunk_resp.choices[0].delta
        if delta.content:
            yield f"data: {json.dumps({'token': delta.content}, ensure_ascii=False)}\n\n"
    yield "data: [DONE]\n\n"


def _rehydrate_seed_chunks(
    searcher: Searcher,
    seed_results: Sequence[dict[str, Any]],
) -> list[dict[str, Any]]:
    chunk_ids = [_safe_text(seed.get("chunk_id")) for seed in seed_results if _safe_text(seed.get("chunk_id"))]
    canonical = {item.chunk_id: _to_source_dict(item) for item in searcher.get_chunks_by_ids(chunk_ids)}

    hydrated: list[dict[str, Any]] = []
    for seed in seed_results:
        chunk_id = _safe_text(seed.get("chunk_id"))
        hydrated.append(_merge_seed_with_canonical(seed, canonical.get(chunk_id)))
    return hydrated


def _build_fast_prompt(chunks: list[dict[str, Any]]) -> str:
    chunks_text = "\n\n".join(_format_source_block(i, chunk) for i, chunk in enumerate(chunks, start=1))
    return _FAST_SYNTHESIS_SYSTEM_PROMPT.format(chunks=chunks_text.strip())


def _advanced_doc_chunks(
    searcher: Searcher,
    query_text: str,
    seed_doc: dict[str, Any],
    *,
    chunks_per_document: int,
    search_mode: str,
    section_filter: str | None = None,
) -> list[dict[str, Any]]:
    doc_id = _safe_text(seed_doc.get("doc_id"))
    journal_id = _safe_text(seed_doc.get("journal_id")) or None

    candidate_limit = max(chunks_per_document * 4, chunks_per_document + 4)
    retrieved = searcher.search(
        query_text,
        top_k=candidate_limit,
        mode=search_mode,
        journal_id=journal_id,
        section=section_filter,
        doc_id=doc_id,
        prefetch_limit=max(candidate_limit * 3, candidate_limit),
    )

    sources = [_to_source_dict(item) for item in retrieved]

    exact_seed = _safe_text(seed_doc.get("chunk_id"))
    if exact_seed and all(src.get("chunk_id") != exact_seed for src in sources):
        canonical = searcher.get_chunks_by_ids([exact_seed])
        if canonical:
            item = canonical[0]
            sources.insert(
                0,
                {
                    "chunk_id": item.chunk_id,
                    "doc_id": item.doc_id,
                    "text": item.text,
                    "title": item.title,
                    "section": item.section,
                    "score": item.score,
                    "chunk_index": item.chunk_index,
                    "journal_id": item.journal_id,
                    "char_len": item.char_len,
                },
            )

    unique_sources: list[dict[str, Any]] = []
    seen_chunk_ids: set[str] = set()
    for source in sources:
        chunk_id = _safe_text(source.get("chunk_id"))
        if not chunk_id or chunk_id in seen_chunk_ids:
            continue
        seen_chunk_ids.add(chunk_id)
        unique_sources.append(source)
    return _select_diverse_chunks(
        unique_sources,
        limit=chunks_per_document,
        preferred_chunk_id=exact_seed or None,
    )


def _select_diverse_chunks(
    sources: Sequence[dict[str, Any]],
    *,
    limit: int,
    preferred_chunk_id: str | None = None,
) -> list[dict[str, Any]]:
    ordered = sorted(sources, key=lambda source: float(source.get("score", 0.0) or 0.0), reverse=True)
    selected: list[dict[str, Any]] = []
    seen_chunk_ids: set[str] = set()
    seen_buckets: set[str] = set()
    bucket_priority = [
        "methods",
        "results",
        "discussion",
        "introduction",
        "theory",
        "conclusion",
        "recommendations",
        "abstract",
        "other",
    ]

    def add_source(source: dict[str, Any]):
        chunk_id = _safe_text(source.get("chunk_id"))
        if not chunk_id or chunk_id in seen_chunk_ids or len(selected) >= limit:
            return
        selected.append(source)
        seen_chunk_ids.add(chunk_id)
        seen_buckets.add(_section_bucket(_safe_text(source.get("section"))))

    if preferred_chunk_id:
        for source in ordered:
            if _safe_text(source.get("chunk_id")) == preferred_chunk_id:
                add_source(source)
                break

    for bucket in bucket_priority:
        if len(selected) >= limit:
            break
        if bucket in seen_buckets:
            continue
        for source in ordered:
            if _section_bucket(_safe_text(source.get("section"))) == bucket:
                add_source(source)
                break

    for source in ordered:
        add_source(source)
        if len(selected) >= limit:
            break

    return selected


def _select_advanced_documents(
    searcher: Searcher,
    query_text: str,
    seed_results: Sequence[dict[str, Any]],
    *,
    max_documents: int,
    search_mode: str,
    journal_id: str | None,
    section: str | None,
    doc_id: str | None,
) -> list[dict[str, Any]]:
    candidate_limit = max(max_documents * 8, len(seed_results) * 4, 16)
    retrieved = searcher.search(
        query_text,
        top_k=candidate_limit,
        mode=search_mode,
        journal_id=journal_id,
        section=section,
        doc_id=doc_id,
        prefetch_limit=max(candidate_limit * 3, candidate_limit),
    )
    candidate_chunks = [_to_source_dict(item) for item in retrieved]
    for source in _rehydrate_seed_chunks(searcher, seed_results):
        if all(source["chunk_id"] != existing["chunk_id"] for existing in candidate_chunks):
            candidate_chunks.append(source)

    grouped: dict[str, dict[str, Any]] = {}
    seed_doc_ids = {_safe_text(seed.get("doc_id")) for seed in seed_results}
    for source in candidate_chunks:
        source_doc_id = _safe_text(source.get("doc_id"))
        if not source_doc_id:
            continue
        bucket = _section_bucket(_safe_text(source.get("section")))
        entry = grouped.setdefault(
            source_doc_id,
            {
                "best": source,
                "scores": [],
                "buckets": set(),
                "seed_bonus": 1.0 if source_doc_id in seed_doc_ids else 0.0,
            },
        )
        entry["scores"].append(float(source.get("score", 0.0) or 0.0))
        entry["buckets"].add(bucket)
        if float(source.get("score", 0.0) or 0.0) > float(entry["best"].get("score", 0.0) or 0.0):
            entry["best"] = source

    ranked: list[tuple[float, dict[str, Any]]] = []
    for entry in grouped.values():
        ordered_scores = sorted(entry["scores"], reverse=True)
        top_score = ordered_scores[0]
        avg_top = sum(ordered_scores[:3]) / min(3, len(ordered_scores))
        diversity_bonus = min(len(entry["buckets"]), 4) / 4
        aggregate = (0.55 * top_score) + (0.25 * avg_top) + (0.15 * diversity_bonus) + (0.05 * entry["seed_bonus"])
        ranked.append((aggregate, entry["best"]))

    ranked.sort(key=lambda item: item[0], reverse=True)
    return [doc for _, doc in ranked[:max_documents]] or _seed_documents(seed_results, max_documents=max_documents)


def _build_evidence_prompt(
    query: str,
    seed_doc: dict[str, Any],
    chunks: list[dict[str, Any]],
    doc_index: int,
) -> tuple[list[dict[str, str]], dict[str, Any]]:
    chunks_text = "\n\n".join(_format_source_block(i, chunk) for i, chunk in enumerate(chunks, start=1))
    title = _safe_text(seed_doc.get("title"), 80) or "Unknown"
    system = _ADVANCED_EVIDENCE_SYSTEM_PROMPT.format(chunks=chunks_text.strip())
    system += f"\n\nمعلومات المستند: {doc_index} | {title} | doc_id={_safe_text(seed_doc.get('doc_id'))}"
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": query},
    ]
    return messages, {
        "doc_index": doc_index,
        "doc_id": _safe_text(seed_doc.get("doc_id")),
        "title": title,
    }


def _parse_json_object(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()
    return json.loads(text)


def _extract_document_evidence(
    client,
    query: str,
    seed_doc: dict[str, Any],
    chunks: list[dict[str, Any]],
    doc_index: int,
) -> dict[str, Any]:
    messages, defaults = _build_evidence_prompt(query, seed_doc, chunks, doc_index)
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=messages,
        temperature=0.15,
        max_tokens=1800,
        response_format={"type": "json_object"},
    )
    raw = response.choices[0].message.content or "{}"
    try:
        data = _parse_json_object(raw)
    except Exception:
        logger.warning("Advanced evidence JSON parse failed for doc %s", defaults["doc_id"], exc_info=True)
        data = {}

    if not isinstance(data, dict):
        data = {}
    data.setdefault("doc_index", defaults["doc_index"])
    data.setdefault("doc_id", defaults["doc_id"])
    data.setdefault("title", defaults["title"])
    data.setdefault("research_focus", "غير مذكور")
    data.setdefault("methodology", "غير مذكور")
    data.setdefault("sample", "غير مذكور")
    data.setdefault("key_findings", [])
    data.setdefault("statistics", [])
    data.setdefault("limitations", [])
    data.setdefault("implications", [])
    data.setdefault("evidence_quality", "medium")
    data.setdefault("notes", "")
    return data


def _build_advanced_final_prompt(query: str, evidence_docs: list[dict[str, Any]]) -> str:
    evidence = json.dumps(evidence_docs, ensure_ascii=False, indent=2)
    return _ADVANCED_FINAL_SYSTEM_PROMPT.format(evidence=evidence) + f"\n\nالسؤال البحثي: {query}"


def _stream_fast(
    client,
    query: str,
    hydrated_chunks: list[dict[str, Any]],
) -> Generator[str, None, None]:
    system = _build_fast_prompt(hydrated_chunks)
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": query},
    ]
    yield from _stream_completion(
        client,
        messages=messages,
        model="gpt-4o-mini",
        temperature=0.25,
        max_tokens=4096,
    )


def _stream_advanced(
    searcher: Searcher,
    client,
    query: str,
    seed_results: Sequence[dict[str, Any]],
    *,
    max_documents: int,
    chunks_per_document: int,
    use_hyde: bool,
    search_mode: str,
    journal_id: str | None,
    section: str | None,
    doc_id: str | None,
) -> Generator[str, None, None]:
    evidence_docs: list[dict[str, Any]] = []
    retrieval_query = generate_hypothesis(query) if use_hyde else query
    seed_docs = _select_advanced_documents(
        searcher,
        retrieval_query,
        seed_results,
        max_documents=max_documents,
        search_mode=search_mode,
        journal_id=journal_id,
        section=section,
        doc_id=doc_id,
    )

    for doc_index, seed_doc in enumerate(seed_docs, start=1):
        chunks = _advanced_doc_chunks(
            searcher,
            retrieval_query,
            seed_doc,
            chunks_per_document=chunks_per_document,
            search_mode=search_mode,
            section_filter=section,
        )
        if not chunks:
            chunks = _rehydrate_seed_chunks(searcher, [seed_doc])
        evidence_docs.append(_extract_document_evidence(client, query, seed_doc, chunks, doc_index))

    # Surface the structured evidence to the client so the UI can render
    # key-findings / statistics cards alongside the prose synthesis.
    yield f"data: {json.dumps({'evidence': evidence_docs}, ensure_ascii=False)}\n\n"

    final_prompt = _build_advanced_final_prompt(query, evidence_docs)
    messages = [
        {"role": "system", "content": final_prompt},
        {"role": "user", "content": query},
    ]
    yield from _stream_completion(
        client,
        messages=messages,
        model="gpt-4o-mini",
        temperature=0.2,
        max_tokens=4096,
    )


def stream_synthesis(
    searcher: Searcher,
    query: str,
    seed_results: Sequence[dict[str, Any]],
    *,
    mode: SynthesisMode = "fast",
    max_documents: int = 5,
    chunks_per_document: int = 4,
    use_hyde: bool = False,
    search_mode: str = "hybrid",
    journal_id: str | None = None,
    section: str | None = None,
    doc_id: str | None = None,
) -> Generator[str, None, None]:
    """Stream a synthesis grounded in server-side evidence.

    Args:
        searcher: Shared search service bound to the live Qdrant collection.
        query: The original user search query.
        seed_results: Search results from the user-facing search endpoint.
        mode: ``fast`` rehydrates the posted results; ``advanced`` expands each
            seed document with multiple canonical chunks before synthesis.
        max_documents: Maximum unique seed documents to analyse in advanced mode.
        chunks_per_document: Number of canonical chunks to retrieve per document.
        use_hyde: Whether to use HyDE during document-level retrieval.
        search_mode: Qdrant query mode for document-level retrieval.

    Yields:
        SSE-formatted strings: ``data: {"token": "..."}`` and finally ``data: [DONE]``.
    """
    try:
        client = get_openai_client()
    except RuntimeError:
        yield f"data: {json.dumps({'error': 'OPENAI_API_KEY not configured'}, ensure_ascii=False)}\n\n"
        return

    try:
        if mode == "advanced":
            yield from _stream_advanced(
                searcher,
                client,
                query,
                seed_results,
                max_documents=max_documents,
                chunks_per_document=chunks_per_document,
                use_hyde=use_hyde,
                search_mode=search_mode,
                journal_id=journal_id,
                section=section,
                doc_id=doc_id,
            )
            return

        hydrated_chunks = _rehydrate_seed_chunks(searcher, list(seed_results)[:_FAST_SOURCE_LIMIT])
        yield from _stream_fast(client, query, hydrated_chunks)
    except Exception:
        logger.exception("Synthesis stream error")
        yield f"data: {json.dumps({'error': 'حدث خطأ أثناء توليد الملخص. يرجى المحاولة مرة أخرى.'}, ensure_ascii=False)}\n\n"
