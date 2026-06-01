"""
Corpus-wide retrieval-augmented multi-turn chat.

Unlike the document-scoped chat in ``backend.services.chat``, this retrieves
relevant chunks across the WHOLE Qdrant collection for every turn, then streams
a grounded answer that synthesises ACROSS documents with «verbatim» citations.

SSE convention (matches the rest of the app):
    data: {"token": "..."}\n      — streamed answer tokens
    data: {"sources": [...]}\n     — emitted once, after the answer
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
        snippet = (r.text or "").strip()[:SNIPPET_CHARS]
        entry = {
            "doc_id": r.doc_id,
            "title": r.title or r.doc_id,
            "chunk_id": r.chunk_id,
            "score": round(float(r.score), 4),
            "snippet": snippet,
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
) -> AsyncGenerator[str, None]:
    """Yield SSE-formatted lines for a corpus-wide grounded chat turn.

    Fully async: OpenAI calls are awaited on the event loop, and the blocking
    Qdrant retrieval is offloaded to a threadpool via ``asyncio.to_thread`` so a
    streaming request does not occupy a worker thread for its whole lifetime.

    Args:
        message: The new user question.
        history: Prior ``[{"role": "user"|"assistant", "content": "..."}]`` turns.
        searcher: A ``Searcher`` instance used for retrieval.

    Yields:
        SSE lines: ``data: {"token": ...}``, then one ``data: {"sources": [...]}``,
        then ``data: [DONE]``.
    """
    try:
        query = await _reformulate_query(message, history)
        results = await asyncio.to_thread(
            searcher.search, query, top_k=RETRIEVE_TOP_K, mode="hybrid"
        )
    except Exception:
        logger.exception("Corpus chat retrieval error")
        yield f"data: {json.dumps({'error': 'حدث خطأ أثناء البحث في المصادر. يرجى المحاولة مرة أخرى.'})}\n\n"
        yield "data: [DONE]\n\n"
        return

    if not results:
        yield f"data: {json.dumps({'token': 'لم أجد مصادر ذات صلة بسؤالك في قاعدة البيانات.'})}\n\n"
        yield f"data: {json.dumps({'sources': []})}\n\n"
        yield "data: [DONE]\n\n"
        return

    context = _build_context(results)
    system = SYSTEM_PROMPT.format(context=context)

    messages: list[dict[str, str]] = [{"role": "system", "content": system}]
    for msg in history[-MAX_HISTORY:]:
        if msg.get("role") in ("user", "assistant") and msg.get("content"):
            messages.append({"role": msg["role"], "content": msg["content"]})
    messages.append({"role": "user", "content": message})

    client = get_async_openai_client()

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
                yield f"data: {json.dumps({'token': delta.content})}\n\n"
    except Exception:
        logger.exception("Corpus chat stream error")
        yield f"data: {json.dumps({'error': 'حدث خطأ أثناء معالجة طلبك. يرجى المحاولة مرة أخرى.'})}\n\n"
        yield "data: [DONE]\n\n"
        return

    sources = _build_sources(results)
    yield f"data: {json.dumps({'sources': sources}, ensure_ascii=False)}\n\n"
    yield "data: [DONE]\n\n"
