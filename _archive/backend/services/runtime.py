"""
Shared runtime helpers used by both backend.main (FastAPI routes) and
backend.mcp_server (MCP tools).

Keeps the Searcher singleton, doc-store helpers, and small result-processing
functions in one place so neither module needs to import the other (circular-
import avoidance).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import shutil
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import TYPE_CHECKING

logger = logging.getLogger(__name__)

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


# ── S3-backed document-file cache ─────────────────────────────────────────
# Source PDFs/JSONs live in S3 at  s3://<bucket>/<prefix>/<doc_id>/<file>
# (prefix may be empty, i.e. keyed at the bucket root). ensure_doc_file()
# returns a LOCAL path, lazily downloading on a cache miss into a bounded LRU
# cache dir, so the PyMuPDF rendering code is unchanged and repeat views are
# local-disk fast. If DOC_S3_BUCKET is unset, behaviour is unchanged (local
# dirs only). See docs/doc_store.md for the full design + env vars.
#
# Concurrency model (built for scale):
#   * Cache HITS resolve in the caller's thread (cheap stat, no pool).
#   * Cache MISSES (S3 downloads) run on a SEPARATE bounded pool so a burst of
#     slow ~MB downloads can't starve the default executor that renders pages.
#   * One download per doc_id at a time (per-doc lock) — no thundering herd.
#   * A short-TTL negative cache stops repeated S3 round-trips for missing docs.
_DOC_S3_BUCKET = os.getenv("DOC_S3_BUCKET")
_DOC_S3_PREFIX = os.getenv("DOC_S3_PREFIX", "docs").strip("/")
_DOC_S3_REGION = os.getenv("DOC_S3_REGION") or None
_DOC_CACHE_DIR = Path(
    os.getenv("DOC_CACHE_DIR", str(Path(__file__).resolve().parent.parent.parent / ".doc_cache"))
)
_DOC_CACHE_MAX_BYTES = int(float(os.getenv("DOC_CACHE_MAX_GB", "20")) * 1024 ** 3)
_DOC_DOWNLOAD_WORKERS = int(os.getenv("DOC_DOWNLOAD_WORKERS", "8"))
_DOC_S3_MAX_POOL = int(os.getenv("DOC_S3_MAX_POOL", "50"))
_NEG_TTL = float(os.getenv("DOC_NEG_CACHE_TTL", "60"))
_EVICT_GRACE = 15.0          # don't evict a doc touched within this many seconds
_DOC_LOCKS_MAX = 4096        # cap the per-doc lock map (prevents unbounded growth)
_NEG_CACHE_MAX = 8192

_s3_client = None
_s3_client_lock = threading.Lock()
# Dedicated pool for S3 downloads, isolated from the default render executor.
_download_pool = ThreadPoolExecutor(
    max_workers=_DOC_DOWNLOAD_WORKERS, thread_name_prefix="docdl"
)
_doc_locks: OrderedDict[str, threading.Lock] = OrderedDict()
_doc_locks_guard = threading.Lock()
_neg_cache: OrderedDict[str, float] = OrderedDict()  # "doc_id/file" -> last-miss monotonic ts
_neg_cache_guard = threading.Lock()
_cache_evict_lock = threading.Lock()
_cache_bytes_lock = threading.Lock()
_cache_bytes: int | None = None  # lazily initialised running total of cache size


def _s3():
    global _s3_client
    if _s3_client is None:
        with _s3_client_lock:
            if _s3_client is None:
                import boto3
                from botocore.config import Config

                _s3_client = boto3.client(
                    "s3",
                    region_name=_DOC_S3_REGION,
                    config=Config(
                        max_pool_connections=_DOC_S3_MAX_POOL,
                        connect_timeout=5,
                        read_timeout=30,
                        retries={"max_attempts": 3, "mode": "adaptive"},
                    ),
                )
    return _s3_client


def _doc_lock(doc_id: str) -> threading.Lock:
    """Per-doc download lock from a size-capped LRU map (bounded memory).

    Evicting an in-use lock is harmless: the holder keeps its own reference; at
    worst a concurrent request for the same doc re-creates one and a duplicate
    (idempotent) download happens.
    """
    with _doc_locks_guard:
        lk = _doc_locks.get(doc_id)
        if lk is None:
            lk = _doc_locks[doc_id] = threading.Lock()
            if len(_doc_locks) > _DOC_LOCKS_MAX:
                _doc_locks.popitem(last=False)
        else:
            _doc_locks.move_to_end(doc_id)
        return lk


def _resolve_local(doc_id: str, filename: str) -> Path | None:
    """Fast path: existing local doc dir or a cache hit. No network."""
    local = doc_dir(doc_id) / filename
    if local.is_file():
        return local
    cache_path = _DOC_CACHE_DIR / doc_id / filename
    if cache_path.is_file():
        with contextlib.suppress(OSError):
            os.utime(cache_path, None)  # bump mtime for LRU / evict grace
        return cache_path
    return None


def _download_from_s3(doc_id: str, filename: str) -> Path | None:
    """Slow path: fetch one file from S3 into the cache (one per doc at a time)."""
    nkey = f"{doc_id}/{filename}"
    now = time.monotonic()
    with _neg_cache_guard:
        miss = _neg_cache.get(nkey)
        if miss is not None and (now - miss) < _NEG_TTL:
            return None

    cache_path = _DOC_CACHE_DIR / doc_id / filename
    key = f"{_DOC_S3_PREFIX}/{nkey}" if _DOC_S3_PREFIX else nkey
    with _doc_lock(doc_id):
        if cache_path.is_file():  # filled while we waited
            return cache_path
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache_path.with_name(f"{cache_path.name}.{threading.get_ident()}.tmp")
        try:
            _s3().download_file(_DOC_S3_BUCKET, key, str(tmp))
            os.replace(tmp, cache_path)
        except Exception as e:  # noqa: BLE001 — missing key / network -> not found
            with contextlib.suppress(FileNotFoundError):
                tmp.unlink()
            with _neg_cache_guard:
                _neg_cache[nkey] = now
                if len(_neg_cache) > _NEG_CACHE_MAX:
                    _neg_cache.popitem(last=False)
            logger.warning("doc fetch miss s3://%s/%s: %s", _DOC_S3_BUCKET, key, e)
            return None

    _note_cache_add(cache_path)
    return cache_path


def ensure_doc_file(doc_id: str, filename: str) -> Path | None:
    """Return a local path to ``<doc_id>/<filename>``, or None if not found.

    Resolution order: existing local doc dir → local cache → download from S3.
    Caller MUST have already validated ``doc_id`` against ``_DOC_ID_RE``.
    Blocking; prefer :func:`ensure_doc_file_async` from async request handlers.
    """
    p = _resolve_local(doc_id, filename)
    if p is not None:
        return p
    if not _DOC_S3_BUCKET:
        return None
    return _download_from_s3(doc_id, filename)


async def ensure_doc_file_async(doc_id: str, filename: str) -> Path | None:
    """Async wrapper: cache hits resolve on the default pool (fast); S3 misses
    run on the dedicated download pool so they can't starve page rendering."""
    loop = asyncio.get_running_loop()
    p = await loop.run_in_executor(None, _resolve_local, doc_id, filename)
    if p is not None:
        return p
    if not _DOC_S3_BUCKET:
        return None
    return await loop.run_in_executor(_download_pool, _download_from_s3, doc_id, filename)


def _scan_cache_bytes() -> int:
    total = 0
    if _DOC_CACHE_DIR.exists():
        for d in _DOC_CACHE_DIR.iterdir():
            if not d.is_dir():
                continue
            for f in d.iterdir():
                with contextlib.suppress(OSError):
                    total += f.stat().st_size
    return total


def _note_cache_add(path: Path):
    """Track cache growth incrementally; only sweep when over the cap."""
    global _cache_bytes
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    with _cache_bytes_lock:
        if _cache_bytes is None:
            _cache_bytes = _scan_cache_bytes()
        else:
            _cache_bytes += size
        over = _cache_bytes > _DOC_CACHE_MAX_BYTES
    if over:
        _enforce_cache_limit()


def _enforce_cache_limit():
    """Evict least-recently-used doc dirs when the cache exceeds its size cap.

    Authoritative full scan, but only invoked when the incremental counter
    crosses the cap (not on every download). Skips dirs touched within
    ``_EVICT_GRACE`` seconds so a file being served isn't deleted mid-stream.
    """
    global _cache_bytes
    if _DOC_CACHE_MAX_BYTES <= 0 or not _DOC_CACHE_DIR.exists():
        return
    if not _cache_evict_lock.acquire(blocking=False):
        return  # another thread is already evicting
    try:
        entries = []
        total = 0
        now = time.time()
        for d in _DOC_CACHE_DIR.iterdir():
            if not d.is_dir():
                continue
            size = 0
            newest = 0.0
            for f in d.iterdir():
                try:
                    st = f.stat()
                except OSError:
                    continue
                size += st.st_size
                newest = max(newest, st.st_mtime)
            entries.append((newest, size, d))
            total += size
        if total > _DOC_CACHE_MAX_BYTES:
            target = int(_DOC_CACHE_MAX_BYTES * 0.9)
            entries.sort(key=lambda e: e[0])  # oldest first
            for newest, size, d in entries:
                if total <= target:
                    break
                if now - newest < _EVICT_GRACE:
                    continue  # in active use — leave it
                with contextlib.suppress(OSError):
                    shutil.rmtree(d)
                    total -= size
        with _cache_bytes_lock:
            _cache_bytes = total
    finally:
        _cache_evict_lock.release()


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
