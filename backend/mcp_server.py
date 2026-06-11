"""
MCP server for the Mandumah Arabic academic corpus.

Exposes 4 retrieval-only tools via FastMCP (Streamable HTTP, stateless):
  - search_articles
  - get_article
  - get_article_passages
  - get_corpus_overview

Retrieval-only guarantee: this module MUST NOT import or call
backend.services.synthesis, backend.services.chat,
backend.services.corpus_chat, or backend.services.hyde.
The only model call permitted per request is the query embedding
(via backend.services.search.Searcher which uses OpenAI text-embedding-3-small).

Mounted into the FastAPI app at POST /mcp in backend.main.
Auth is handled by the existing X-API-Key middleware that wraps all routes.

phase 2: OAuth — replace X-API-Key with OAuth 2.1/Entra ID for the Microsoft
gallery submission.
"""

# Note: do NOT add `from __future__ import annotations` here.
# FastMCP introspects function parameter annotations at decoration time; the
# postponed-evaluation behaviour of that future import turns all annotations
# into strings, which breaks issubclass() checks inside the MCP SDK.

import anyio
import os
from typing import Optional

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError

from backend.services.runtime import (
    _DOC_ID_RE,
    doc_dir,
    load_doc_content_cached,
    get_searcher,
    dedup_results,
    compute_low_confidence,
    get_corpus_stats,
)

# ── Configuration ─────────────────────────────────────────────────────────

_PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")
_COLLECTION_NAME = os.getenv("COLLECTION_NAME", "academic_articles")

# ── FastMCP instance ──────────────────────────────────────────────────────

mcp = FastMCP(
    "mandumah-search",
    stateless_http=True,
    json_response=True,
    # streamable_http_path="/" so that when mounted at /mcp the final
    # public endpoint is exactly POST /mcp (not /mcp/mcp).
    streamable_http_path="/",
)


# ── Helpers ────────────────────────────────────────────────────────────────

def _validate_doc_id(doc_id: str) -> None:
    """Reject doc_id values that do not match the canonical pattern.

    This is the path-traversal guard — call before ANY filesystem access.
    Raises ToolError on invalid input.
    """
    # Length guard first to avoid scanning very long strings through the regex.
    if not doc_id or len(doc_id) > 64:
        raise ToolError(f"Invalid doc_id: {doc_id!r}")
    # Reject any byte that isn't printable ASCII (e.g. null bytes).
    if any(ord(c) < 0x20 or ord(c) > 0x7E for c in doc_id):
        raise ToolError(f"Invalid doc_id: {doc_id!r}")
    if not _DOC_ID_RE.match(doc_id):
        raise ToolError(f"Invalid doc_id format: {doc_id!r}. Expected YYYY-JJJ-VVV-PPP")


def _make_pdf_url(doc_id: str) -> str:
    return f"{_PUBLIC_BASE_URL}/api/pdf/{doc_id}"


def _truncate_snippet(text: str, max_chars: int = 700) -> str:
    """Truncate *text* to at most *max_chars* on a word boundary, appending '…'."""
    if len(text) <= max_chars:
        return text
    # Cut at the last word boundary within max_chars.
    cut = text[:max_chars]
    last_space = cut.rfind(" ")
    if last_space > max_chars // 2:
        cut = cut[:last_space]
    return cut + "…"


def _result_to_dict(r, snippet: bool = True) -> dict:
    """Convert a SearchResult dataclass to a JSON-serialisable dict."""
    text = _truncate_snippet(r.text) if snippet else r.text
    return {
        "doc_id": r.doc_id,
        "title": r.title or None,
        "section": r.section or None,
        "journal_id": r.journal_id or None,
        "score": round(r.score, 4),
        "snippet": text,
        "chunk_index": r.chunk_index,
        "pdf_url": _make_pdf_url(r.doc_id),
    }


def _get_title_for_doc(doc_id: str) -> str | None:
    """Query Qdrant for the title of *doc_id*; returns None if not found."""
    try:
        from qdrant_client import models

        searcher = get_searcher()
        results = searcher.client.scroll(
            collection_name=searcher.collection_name,
            scroll_filter=models.Filter(
                must=[
                    models.FieldCondition(
                        key="doc_id",
                        match=models.MatchValue(value=doc_id),
                    )
                ]
            ),
            limit=1,
            with_payload=True,
            with_vectors=False,
        )
        points = results[0]
        if points:
            return points[0].payload.get("title") or None
    except Exception:
        pass
    return None


# ── Tools ─────────────────────────────────────────────────────────────────


@mcp.tool()
async def search_articles(
    query: str,
    top_k: int = 10,
    journal_id: Optional[str] = None,
    section: Optional[str] = None,
) -> dict:
    """Search the Mandumah Arabic academic article corpus.

    Returns ranked passages with metadata. Results are in Arabic; Arabic
    queries retrieve best. Use get_article for the full text of a specific
    result, or get_article_passages to drill into a particular paper.

    Args:
        query: Natural-language search query. Arabic recommended.
        top_k: Number of deduplicated results to return (1–25). Values
               outside this range are clamped rather than raising an error.
        journal_id: Optional 4-digit journal filter, e.g. "2048".
        section: Optional section-name filter.

    Returns:
        {query, total, low_confidence, results: [{doc_id, title, section,
        journal_id, score, snippet, chunk_index, pdf_url}]}
    """
    # Validate query
    query = (query or "").strip()
    if not query:
        raise ToolError("Query cannot be empty")
    if len(query) > 2000:
        raise ToolError("Query exceeds maximum length of 2000 characters")

    # Clamp top_k
    top_k = max(1, min(25, top_k))

    # Fetch more candidates to survive dedup
    fetch_k = min(top_k * 5, 100)

    searcher = get_searcher()
    results = await anyio.to_thread.run_sync(
        lambda: searcher.search(
            query,
            top_k=fetch_k,
            mode="hybrid",
            journal_id=journal_id,
            section=section,
        )
    )

    # Dedup: top chunk per doc, truncate to top_k (shared function — same object
    # as the one used by /api/search when deduplicate=true).
    results = dedup_results(results, top_k)
    low_confidence = compute_low_confidence(results)

    return {
        "query": query,
        "total": len(results),
        "low_confidence": low_confidence,
        "results": [_result_to_dict(r, snippet=True) for r in results],
    }


@mcp.tool()
async def get_article(
    doc_id: str,
    max_chars: int = 8000,
    offset: int = 0,
) -> dict:
    """Fetch the full text of a Mandumah article by its document ID.

    Supports paging via offset + max_chars for long articles.
    Use search_articles first to discover doc_id values.

    Args:
        doc_id: Document identifier, e.g. "2048-014-003-024".
        max_chars: Maximum characters to return (1000–40000, clamped).
        offset: Character offset for paging through long articles.

    Returns:
        {doc_id, title, journal_id, total_chars, offset, text, truncated, pdf_url}
    """
    _validate_doc_id(doc_id)

    # Clamp max_chars
    max_chars = max(1000, min(40000, max_chars))
    offset = max(0, offset)

    # Load full content (synchronous I/O off the event loop)
    json_path = doc_dir(doc_id) / f"{doc_id}.json"
    if not json_path.is_file():
        raise ToolError(f"Article not found: {doc_id}")

    content = await anyio.to_thread.run_sync(
        lambda: load_doc_content_cached(json_path)
    )

    total_chars = len(content)

    # Paging slice
    if offset >= total_chars:
        text_slice = ""
        truncated = False
    else:
        text_slice = content[offset : offset + max_chars]
        truncated = (offset + max_chars) < total_chars

    # Title from Qdrant index (the JSON has no title field)
    title = await anyio.to_thread.run_sync(lambda: _get_title_for_doc(doc_id))

    # Derive journal_id from doc_id (first 4 digits)
    journal_id = doc_id[:4]

    return {
        "doc_id": doc_id,
        "title": title,
        "journal_id": journal_id,
        "total_chars": total_chars,
        "offset": offset,
        "text": text_slice,
        "truncated": truncated,
        "pdf_url": _make_pdf_url(doc_id),
    }


@mcp.tool()
async def get_article_passages(
    doc_id: str,
    query: str,
    top_k: int = 5,
) -> dict:
    """Search for relevant passages within a specific Mandumah article.

    Lets Copilot drill into a particular paper without pulling the full text
    via get_article. Results are scoped to a single article; multiple chunks
    from that article may be returned (no deduplication applied).

    Args:
        doc_id: Document identifier, e.g. "2048-014-003-024".
        query: What to look for inside this article. Arabic recommended.
        top_k: Number of passages to return (1–10, clamped).

    Returns:
        {doc_id, query, total, results: [{doc_id, title, section, journal_id,
        score, snippet, chunk_index, pdf_url}]}
    """
    _validate_doc_id(doc_id)

    query = (query or "").strip()
    if not query:
        raise ToolError("Query cannot be empty")
    if len(query) > 2000:
        raise ToolError("Query exceeds maximum length of 2000 characters")

    top_k = max(1, min(10, top_k))

    searcher = get_searcher()
    results = await anyio.to_thread.run_sync(
        lambda: searcher.search(
            query,
            top_k=top_k,
            mode="hybrid",
            doc_id=doc_id,
        )
    )

    # Return full chunk text (not the 700-char snippet) since results are scoped
    # to one article.
    return {
        "doc_id": doc_id,
        "query": query,
        "total": len(results),
        "results": [_result_to_dict(r, snippet=False) for r in results],
    }


@mcp.tool()
async def get_corpus_overview() -> dict:
    """Return a high-level overview of the Mandumah corpus.

    Useful for demo-friendly queries such as "how many articles do you cover?"
    and to help the orchestrator understand the scope of available knowledge.

    Returns:
        {documents, chunks, collection, language, description}
    """
    stats = await anyio.to_thread.run_sync(get_corpus_stats)

    return {
        "documents": stats.get("documents", 0),
        "chunks": stats.get("chunks", 0),
        "collection": _COLLECTION_NAME,
        "language": "ar",
        "description": (
            "Mandumah is an Arabic academic journal corpus covering research "
            "across disciplines including education, social sciences, Islamic "
            "studies, and humanities. All full texts are in Arabic."
        ),
    }


# ── ASGI app (call after tool registration so session_manager is ready) ───
mcp_app = mcp.streamable_http_app()
