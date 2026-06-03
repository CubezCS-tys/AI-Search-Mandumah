"""
Corpus-wide retrieval-augmented multi-turn chat.

Unlike the document-scoped chat in ``backend.services.chat``, this retrieves
relevant chunks across the WHOLE Qdrant collection for every turn, then streams
a grounded answer that synthesises ACROSS documents with «verbatim» citations.

SSE convention (matches the rest of the app):
    data: {"meta": {...}}\n        — emitted once, after retrieval (query/counts)
    data: {"sources": [...]}\n     — emitted once, before the answer
    data: {"token": "..."}\n      — streamed answer tokens
    data: {"followups": [...]}\n   — emitted once, after the answer
    data: {"error": "..."}\n       — on failure
    data: [DONE]\n                 — terminal sentinel
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncGenerator

from backend.services.openai_client import get_async_openai_client

logger = logging.getLogger(__name__)

# Retrieval / context budgeting
RETRIEVE_TOP_K = 10
MAX_CHUNK_CHARS = 1_800  # per chunk in the context block
MAX_HISTORY = 20  # conversation turns passed to the model
SNIPPET_CHARS = 200

# Long-conversation memory: keep the most recent turns verbatim; once the thread
# grows past the trigger, the older turns are distilled into a compact running
# summary so context quality doesn't degrade over long sessions.
RECENT_TURNS = 8  # most-recent turns always passed verbatim
SUMMARY_TRIGGER = 12  # summarize older turns once history exceeds this many turns

# Deep (agentic) retrieval: decompose a complex question into focused
# sub-queries, retrieve for each, then merge/dedup before synthesising.
DEEP_MAX_SUBQUERIES = 4
DEEP_TOTAL_CHUNKS = 18  # cap on merged chunks fed to the model in deep mode

SYSTEM_PROMPT = """\
You are a smart, helpful research assistant embedded in an academic search \
platform called المنظومة. Unlike a single-document assistant, you answer \
questions by synthesising across MULTIPLE scholarly documents retrieved from \
the whole corpus. Relevant excerpts are provided below, each labelled with an \
index ‎[N]‎ and its source document title.

## CITATION RULE — READ THIS FIRST

Every sentence you write that states a fact from the excerpts MUST contain a \
«quoted passage» copied verbatim from the excerpt text. The «» quotes become \
clickable links in the UI — if you skip them, the user gets an unverifiable \
wall of text.

**How to cite:**
- Copy exact words from an excerpt inside « and ». Copy CHARACTER BY CHARACTER.
- Keep quotes short: 3-10 words each. Multiple short «quotes» per sentence is ideal.
- NEVER paraphrase inside «». NEVER reorder or add words.
- When useful, also name the source document, e.g. (المستند [2]).
- Aim for 2-4 «citations» per paragraph.

## How to Respond

- **Synthesise across documents.** Compare, contrast, and connect findings from \
different sources. Note agreements and contradictions explicitly.
- **Default to thorough answers.** Use markdown headings, bullet lists, bold, \
and tables where they help.
- **Stay grounded in the excerpts.** Every claim traces back to a «quoted» \
passage. If the excerpts don't cover the question, say so plainly: \
"لم أجد ما يكفي من المصادر للإجابة عن هذا".
- **Match the user's language.** Arabic → Arabic. English → English.
- **Be proactive.** End with 1-2 useful follow-up questions.

## Boundaries

- Don't bring in outside knowledge. The excerpts are your only source.
- Don't invent numbers, results, or citations.

## Retrieved Excerpts

{context}

REMINDER: Every factual sentence MUST have at least one «verbatim quote» from \
the excerpts. No exceptions.
"""

_REWRITE_SYSTEM_PROMPT = """\
You rewrite a user's latest message into a single standalone search query for a \
semantic search engine over an Arabic academic corpus. Use the conversation \
context to resolve pronouns and references. Respond with ONLY the rewritten \
query text — no quotes, no explanation, in the same language as the user."""

_DECOMPOSE_SYSTEM_PROMPT = """\
You break a complex research question into focused sub-questions for searching \
an Arabic academic corpus. Return a JSON object of the form \
{"subqueries": ["...", "..."]} with 2 to 4 items, each targeting ONE \
retrievable aspect of the question. If the question is already simple and \
atomic, return it unchanged as a single-item list. Use the same language as the \
question."""

_SUMMARY_SYSTEM_PROMPT = """\
You compress an earlier portion of a research conversation into a brief factual \
summary (3-6 sentences) capturing the topics discussed, the key findings \
surfaced, and any open threads, so a later assistant turn keeps the context. \
Write in the conversation's language. Return ONLY the summary text."""

_FOLLOWUP_SYSTEM_PROMPT = """\
Based on a research answer and its sources, propose exactly 3 concise, specific \
follow-up questions the user is likely to ask next to go deeper. Each must be \
self-contained and answerable from an academic corpus. Return a JSON object of \
the form {"followups": ["...", "...", "..."]}. Use the same language as the \
answer."""


async def _reformulate_query(message: str, history: list[dict[str, str]]) -> str:
    """Rewrite the latest message into a standalone search query.

    Uses a cheap GPT-4o-mini call. Falls back to a heuristic concatenation of
    the last user turn + this message on any error.
    """
    if not history:
        return message

    recent = history[-6:]
    convo = "\n".join(
        f"{m['role']}: {m['content']}" for m in recent if m.get("content")
    )
    try:
        client = get_async_openai_client()
        resp = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": _REWRITE_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": f"Conversation:\n{convo}\n\nLatest message:\n{message}\n\nStandalone query:",
                },
            ],
            temperature=0.0,
            max_tokens=128,
        )
        rewritten = (resp.choices[0].message.content or "").strip()
        return rewritten or message
    except Exception:
        logger.warning("Query reformulation failed; using heuristic fallback", exc_info=True)
        last_user = next(
            (m["content"] for m in reversed(history) if m.get("role") == "user"),
            "",
        )
        combined = f"{last_user} {message}".strip()
        return combined or message


async def _decompose_query(query: str) -> list[str]:
    """Break a complex query into focused sub-queries (deep/agentic mode).

    Returns the original query as a single-item list when the question is
    already atomic or on any error.
    """
    try:
        client = get_async_openai_client()
        resp = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": _DECOMPOSE_SYSTEM_PROMPT},
                {"role": "user", "content": query},
            ],
            temperature=0.0,
            max_tokens=256,
            response_format={"type": "json_object"},
        )
        data = json.loads(resp.choices[0].message.content or "{}")
        items = data.get("subqueries") if isinstance(data, dict) else None
        cleaned = (
            [s.strip() for s in items if isinstance(s, str) and s.strip()]
            if isinstance(items, list)
            else []
        )
        # Deduplicate (case-insensitive) preserving order; cap to the budget.
        seen: set[str] = set()
        out: list[str] = []
        for s in cleaned:
            key = s.lower()
            if key not in seen:
                seen.add(key)
                out.append(s)
            if len(out) >= DEEP_MAX_SUBQUERIES:
                break
        return out or [query]
    except Exception:
        logger.warning("Query decomposition failed; using single query", exc_info=True)
        return [query]


async def _multi_retrieve(
    searcher: Any,
    queries: list[str],
    per_query_k: int,
    total_cap: int,
) -> list[Any]:
    """Retrieve for each query in parallel, then merge/dedup by chunk.

    Keeps the best-scoring instance of each chunk and returns the top
    ``total_cap`` results by score.
    """

    async def _one(q: str) -> list[Any]:
        return await asyncio.to_thread(
            searcher.search, q, top_k=per_query_k, mode="hybrid"
        )

    results_lists = await asyncio.gather(
        *[_one(q) for q in queries], return_exceptions=True
    )
    best: dict[str, Any] = {}
    for res in results_lists:
        if isinstance(res, BaseException):
            logger.warning("Sub-query retrieval failed", exc_info=res)
            continue
        for r in res:
            key = r.chunk_id or f"{r.doc_id}:{r.section or ''}"
            existing = best.get(key)
            if existing is None or float(r.score) > float(existing.score):
                best[key] = r
    merged = sorted(best.values(), key=lambda r: float(r.score), reverse=True)
    return merged[:total_cap]


async def _summarize_history(older: list[dict[str, str]]) -> str:
    """Distill older conversation turns into a compact running summary."""
    convo = "\n".join(
        f"{m['role']}: {m['content']}" for m in older if m.get("content")
    )
    if not convo.strip():
        return ""
    try:
        client = get_async_openai_client()
        resp = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": _SUMMARY_SYSTEM_PROMPT},
                {"role": "user", "content": convo},
            ],
            temperature=0.2,
            max_tokens=400,
        )
        return (resp.choices[0].message.content or "").strip()
    except Exception:
        logger.warning("History summarization failed; skipping", exc_info=True)
        return ""


async def _generate_followups(
    message: str, answer: str, source_titles: list[str]
) -> list[str]:
    """Propose up to 3 follow-up questions from the answer + its sources."""
    if not answer.strip():
        return []
    titles = "\n".join(f"- {t}" for t in source_titles[:8])
    try:
        client = get_async_openai_client()
        resp = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": _FOLLOWUP_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": (
                        f"Question:\n{message}\n\n"
                        f"Answer:\n{answer[:4000]}\n\n"
                        f"Sources:\n{titles}"
                    ),
                },
            ],
            temperature=0.5,
            max_tokens=256,
            response_format={"type": "json_object"},
        )
        data = json.loads(resp.choices[0].message.content or "{}")
        items = data.get("followups") if isinstance(data, dict) else None
        out = (
            [s.strip() for s in items if isinstance(s, str) and s.strip()]
            if isinstance(items, list)
            else []
        )
        return out[:3]
    except Exception:
        logger.warning("Follow-up generation failed", exc_info=True)
        return []


def _build_context(results: list[Any]) -> str:
    """Build the labelled excerpt block from search results."""
    blocks: list[str] = []
    for idx, r in enumerate(results, start=1):
        text = (r.text or "")[:MAX_CHUNK_CHARS]
        title = r.title or r.doc_id
        section = f" — {r.section}" if r.section else ""
        blocks.append(f"[{idx}] {title}{section}\n{text}")
    return "\n\n".join(blocks)


def _build_sources(results: list[Any]) -> list[dict[str, Any]]:
    """Deduplicate retrieved results by doc_id, keeping the best score."""
    best: dict[str, dict[str, Any]] = {}
    for r in results:
        text = (r.text or "").strip()[:MAX_CHUNK_CHARS]
        snippet = text[:SNIPPET_CHARS]
        entry = {
            "doc_id": r.doc_id,
            "title": r.title or r.doc_id,
            "chunk_id": r.chunk_id,
            "score": round(float(r.score), 4),
            "snippet": snippet,
            # Full retrieved chunk text — lets the UI map a clicked «quote»
            # back to the document it came from for deep-link highlighting.
            "text": text,
            "section": r.section or "",
            "journal_id": r.journal_id or "",
        }
        existing = best.get(r.doc_id)
        if existing is None or entry["score"] > existing["score"]:
            best[r.doc_id] = entry
    return sorted(best.values(), key=lambda s: s["score"], reverse=True)


async def stream_corpus_chat(
    message: str,
    history: list[dict[str, str]],
    searcher: Any,
    retrieve_top_k: int = RETRIEVE_TOP_K,
    deep: bool = False,
) -> AsyncGenerator[str, None]:
    """Yield SSE-formatted lines for a corpus-wide grounded chat turn.

    Fully async: OpenAI calls are awaited on the event loop, and the blocking
    Qdrant retrieval is offloaded to a threadpool via ``asyncio.to_thread`` so a
    streaming request does not occupy a worker thread for its whole lifetime.

    Args:
        message: The new user question.
        history: Prior ``[{"role": "user"|"assistant", "content": "..."}]`` turns
            (the full thread; older turns are summarised internally).
        searcher: A ``Searcher`` instance used for retrieval.
        retrieve_top_k: Number of chunks to retrieve (raised by "more sources").
        deep: When True, decompose the question into sub-queries and retrieve for
            each (agentic multi-step retrieval) for broader coverage.

    Yields:
        SSE lines: one ``data: {"meta": ...}``, one ``data: {"sources": [...]}``,
        streamed ``data: {"token": ...}``, one ``data: {"followups": [...]}``,
        then ``data: [DONE]``.
    """
    sub_queries: list[str] = []
    try:
        query = await _reformulate_query(message, history)
        if deep:
            sub_queries = await _decompose_query(query)
            if len(sub_queries) > 1:
                results = await _multi_retrieve(
                    searcher,
                    sub_queries,
                    per_query_k=retrieve_top_k,
                    total_cap=max(retrieve_top_k, DEEP_TOTAL_CHUNKS),
                )
            else:
                sub_queries = []
                results = await asyncio.to_thread(
                    searcher.search, query, top_k=retrieve_top_k, mode="hybrid"
                )
        else:
            results = await asyncio.to_thread(
                searcher.search, query, top_k=retrieve_top_k, mode="hybrid"
            )
    except Exception:
        logger.exception("Corpus chat retrieval error")
        yield f"data: {json.dumps({'error': 'حدث خطأ أثناء البحث في المصادر. يرجى المحاولة مرة أخرى.'})}\n\n"
        yield "data: [DONE]\n\n"
        return

    # Retrieval transparency: surface the reformulated query, any sub-queries,
    # and how many chunks were found so the UI can show what was searched.
    meta = {
        "rewritten_query": query if query.strip() != message.strip() else "",
        "sub_queries": sub_queries,
        "source_count": len(results),
        "deep": deep,
    }
    yield f"data: {json.dumps({'meta': meta}, ensure_ascii=False)}\n\n"

    if not results:
        yield f"data: {json.dumps({'token': 'لم أجد مصادر ذات صلة بسؤالك في قاعدة البيانات.'})}\n\n"
        yield f"data: {json.dumps({'sources': []})}\n\n"
        yield "data: [DONE]\n\n"
        return

    # Emit sources up front, as soon as retrieval finishes, so the UI can show
    # them while the answer is still being generated.
    sources = _build_sources(results)
    yield f"data: {json.dumps({'sources': sources}, ensure_ascii=False)}\n\n"

    context = _build_context(results)
    system = SYSTEM_PROMPT.format(context=context)

    # Long-conversation memory: summarise older turns once the thread is long,
    # keeping only the most recent turns verbatim to preserve answer quality.
    if len(history) > SUMMARY_TRIGGER:
        older = history[:-RECENT_TURNS]
        recent = history[-RECENT_TURNS:]
        summary = await _summarize_history(older)
        if summary:
            system += f"\n\n## ملخص المحادثة السابقة\n{summary}\n"
    else:
        recent = history[-MAX_HISTORY:]

    messages: list[dict[str, str]] = [{"role": "system", "content": system}]
    for msg in recent:
        if msg.get("role") in ("user", "assistant") and msg.get("content"):
            messages.append({"role": msg["role"], "content": msg["content"]})
    messages.append({"role": "user", "content": message})

    client = get_async_openai_client()

    answer_parts: list[str] = []
    try:
        stream = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=messages,
            stream=True,
            temperature=0.3,
            max_tokens=16384,
        )
        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta.content:
                answer_parts.append(delta.content)
                yield f"data: {json.dumps({'token': delta.content})}\n\n"
    except Exception:
        logger.exception("Corpus chat stream error")
        yield f"data: {json.dumps({'error': 'حدث خطأ أثناء معالجة طلبك. يرجى المحاولة مرة أخرى.'})}\n\n"
        yield "data: [DONE]\n\n"
        return

    # Proactive follow-up suggestions (best-effort; never blocks the answer).
    followups = await _generate_followups(
        message, "".join(answer_parts), [s["title"] for s in sources]
    )
    if followups:
        yield f"data: {json.dumps({'followups': followups}, ensure_ascii=False)}\n\n"

    yield "data: [DONE]\n\n"
