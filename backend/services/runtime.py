"""
Shared runtime helpers used by both backend.main (FastAPI routes) and
backend.mcp_server (MCP tools).

Keeps the Searcher singleton, doc-store helpers, and small result-processing
functions in one place so neither module needs to import the other (circular-
import avoidance).
"""

from __future__ import annotations

import json
import os
import re
import threading
from collections import OrderedDict
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from backend.services.search import SearchResult

# ── Doc-ID validation ─────────────────────────────────────────────────────
# MUST be applied to every doc_id received from external sources before any
# filesystem access.  Shape: YYYY-JJJ-VVV-PPP (all groups decimal digits).
_DOC_ID_RE = re.compile(r"^\d{4}-\d{3}-\d{3}-\d{3}$")

# ── File-system layout ────────────────────────────────────────────────────
_OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", str(Path(__file__).resolve().parent.parent.parent / "output")))
_EXTRA_DOC_DIRS = [
    Path(d.strip())
    for d in os.getenv(
        "EXTRA_DOC_DIRS",
        str(Path(__file__).resolve().parent.parent.parent / "output_batch05"),
    ).split(",")
    if d.strip()
]


def doc_dir(doc_id: str) -> Path:
    """Locate a document directory.

    Checks the nested ``output/output_XXXX/<doc_id>/`` layout first, then any
    flat extra directories (e.g. ``output_batch05/<doc_id>/``).
    """
    journal_prefix = doc_id[:4]
    nested = _OUTPUT_DIR / f"output_{journal_prefix}" / doc_id
    if nested.is_dir():
        return nested
    for extra in _EXTRA_DOC_DIRS:
        flat = extra / doc_id
        if flat.is_dir():
            return flat
    # Fallback — caller is responsible for handling the resulting 404/error.
    return nested


# ── LRU document-content cache ────────────────────────────────────────────
_DOC_CONTENT_CACHE_MAX = 50
_doc_content_cache: OrderedDict[str, str] = OrderedDict()


def _load_doc_content(json_path: Path) -> str:
    """Read and return the ``content`` field from a document JSON (synchronous)."""
    with open(json_path, encoding="utf-8") as f:
        return json.load(f).get("content", "")


def load_doc_content_cached(json_path: Path) -> str:
    """LRU-cached wrapper around :func:`_load_doc_content`."""
    key = str(json_path)
    if key in _doc_content_cache:
        _doc_content_cache.move_to_end(key)
        return _doc_content_cache[key]
    content = _load_doc_content(json_path)
    _doc_content_cache[key] = content
    if len(_doc_content_cache) > _DOC_CONTENT_CACHE_MAX:
        _doc_content_cache.popitem(last=False)
    return content


# ── Lazy Searcher singleton ───────────────────────────────────────────────
_searcher = None
_searcher_lock = threading.Lock()


def get_searcher():
    """Return the shared :class:`~backend.services.search.Searcher` singleton.

    Lazy and thread-safe.  Reads ``QDRANT_URL`` and ``COLLECTION_NAME`` from
    the environment.
    """
    global _searcher
    if _searcher is None:
        with _searcher_lock:
            if _searcher is None:
                from backend.services.search import Searcher

                _searcher = Searcher(
                    qdrant_url=os.getenv("QDRANT_URL", "http://localhost:6333"),
                    collection_name=os.getenv("COLLECTION_NAME", "academic_articles"),
                )
    return _searcher


# ── Deduplication helper ──────────────────────────────────────────────────

def dedup_results(results: list, top_k: int) -> list:
    """Keep the highest-ranked chunk per ``doc_id``, truncate to *top_k*.

    This is the canonical dedup used by both ``/api/search`` (deduplicate=true)
    and ``search_articles`` in the MCP server.  Both call this same function
    object — import identity is tested in the test suite.
    """
    seen: dict[str, object] = {}
    for r in results:
        if r.doc_id not in seen:
            seen[r.doc_id] = r
    return list(seen.values())[:top_k]


# ── Low-confidence flag ───────────────────────────────────────────────────

def compute_low_confidence(results: list) -> bool:
    """Return True when the top results look weak.

    Mirrors the identical logic in ``/api/search``.
    """
    if not results:
        return True
    top_score = results[0].score
    top_window = results[: min(3, len(results))]
    avg_lexical = sum(getattr(r, "lexical_score", 0.0) for r in top_window) / len(top_window)
    return top_score < 0.34 or avg_lexical < 0.14


# ── Corpus stats helper ───────────────────────────────────────────────────

def get_corpus_stats() -> dict:
    """Return ``{chunks, documents}`` from Qdrant.

    Mirrors the ``/api/stats`` route logic; used by both that route and the
    ``get_corpus_overview`` MCP tool.  Degrades gracefully on Qdrant failure.
    """
    try:
        searcher = get_searcher()
        info = searcher.client.get_collection(searcher.collection_name)
        chunks = info.points_count or 0

        try:
            from qdrant_client import models  # noqa: F401 — imported for side-effects
            facet_response = searcher.client.facet(
                collection_name=searcher.collection_name,
                key="doc_id",
                limit=100_000,
            )
            documents = len(facet_response.hits)
        except Exception:
            documents = 0

        return {"chunks": chunks, "documents": documents}
    except Exception as e:
        return {"chunks": 0, "documents": 0, "error": str(e)}
