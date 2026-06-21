"""
Al-Manthooma Search API.

Thin FastAPI layer over the backend services and pipeline.

Run:
    uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure the project root is on sys.path so `backend.*` imports always resolve,
# regardless of the working directory uvicorn is launched from.
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import re
import threading
import time
from collections import OrderedDict
from io import BytesIO
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv

load_dotenv()

import fitz  # PyMuPDF
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, model_validator

logger = logging.getLogger(__name__)

# ── Shared runtime helpers (avoid circular import with mcp_server) ────────
from backend.services.runtime import (
    _DOC_ID_RE,
    doc_dir as _doc_dir,
    ensure_doc_file_async,
    load_doc_content_cached as _load_doc_content_cached,
    get_searcher,
    dedup_results,
    compute_low_confidence,
    get_corpus_stats,
)

# ── MCP kill switch ───────────────────────────────────────────────────────
_MCP_ENABLED = os.getenv("MCP_ENABLED", "true").lower() not in ("false", "0", "no")

if _MCP_ENABLED:
    from backend.mcp_server import mcp as _mcp_server_instance, mcp_app as _mcp_asgi_app


@contextlib.asynccontextmanager
async def _app_lifespan(app):
    """Wire the MCP session-manager lifespan into the FastAPI app."""
    if _MCP_ENABLED:
        async with _mcp_server_instance.session_manager.run():
            yield
    else:
        yield


app = FastAPI(title="Al-Manthooma Search API", version="0.1.0", lifespan=_app_lifespan)

# CORS — allow configurable origins, default to wildcard for dev
_CORS_ORIGINS = [
    o.strip()
    for o in os.getenv("CORS_ORIGINS", "*").split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Optional API key guard ────────────────────────────────────────────────

_API_KEY = os.getenv("API_KEY")


_API_KEY_EXEMPT_PATHS = {"/api/health", "/docs", "/openapi.json"}


@app.middleware("http")
async def _api_key_guard(request: Request, call_next):
    """If API_KEY env var is set, require a matching X-API-Key header.

    Exempts CORS preflight (OPTIONS) and health-check endpoints.
    """
    if _API_KEY:
        is_exempt = (
            request.method == "OPTIONS"
            or request.url.path in _API_KEY_EXEMPT_PATHS
            # The admin console has its own username/password auth; don't
            # double-gate it behind the corpus API key.
            or request.url.path.startswith("/api/admin")
        )
        if not is_exempt and request.headers.get("X-API-Key") != _API_KEY:
            return Response(
                content="Unauthorized", status_code=401, media_type="text/plain"
            )
    return await call_next(request)


# ── Request size guard + rate limiting ────────────────────────────────────
#
# Both protect the LLM-backed endpoints (chat/synthesis/search) from abuse and
# runaway cost. In-memory only — fine for the current single-host deployment;
# swap for a shared store (Redis) if/when we run multiple replicas.

# Reject request bodies larger than this (bytes). Generous enough for long
# conversation history payloads, tight enough to stop accidental/abusive bulk.
_MAX_BODY_BYTES = int(os.getenv("MAX_BODY_BYTES", str(1 * 1024 * 1024)))  # 1 MiB

# Sliding-window rate limit applied to the expensive POST endpoints below.
_RATE_LIMIT_PER_MINUTE = int(os.getenv("RATE_LIMIT_PER_MINUTE", "60"))
_RATE_LIMITED_PREFIXES = (
    "/api/search",
    "/api/chat",
    "/api/insights",  # public lab routes (GET projection, POST similar)
    "/api/analyze",  # already-public paid GET; previously unthrottled
    "/mcp",
    "/api/admin/login",  # throttle credential brute-force on the open port
)
_rate_window_seconds = 60.0
_rate_hits: dict[str, list[float]] = {}
_rate_lock = threading.Lock()


def _client_key(request: Request) -> str:
    """Identify the caller for rate limiting (proxy-aware, falls back to peer)."""
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",", 1)[0].strip()
    return request.client.host if request.client else "unknown"


def _rate_limit_ok(key: str) -> bool:
    """Record a hit and report whether the caller is within the per-minute budget."""
    now = time.monotonic()
    cutoff = now - _rate_window_seconds
    with _rate_lock:
        hits = _rate_hits.get(key)
        if hits is None:
            hits = []
            _rate_hits[key] = hits
        # Drop timestamps older than the window.
        i = 0
        for ts in hits:
            if ts >= cutoff:
                break
            i += 1
        if i:
            del hits[:i]
        if len(hits) >= _RATE_LIMIT_PER_MINUTE:
            return False
        hits.append(now)
        # Opportunistic cleanup so the dict can't grow unbounded.
        if len(_rate_hits) > 4096:
            for k in [k for k, v in _rate_hits.items() if not v or v[-1] < cutoff]:
                _rate_hits.pop(k, None)
        return True


@app.middleware("http")
async def _abuse_guard(request: Request, call_next):
    """Enforce a max body size and a per-IP rate limit on expensive endpoints."""
    if request.method == "POST":
        # Body size guard — reject early using the declared Content-Length.
        cl = request.headers.get("content-length")
        if cl is not None:
            try:
                if int(cl) > _MAX_BODY_BYTES:
                    return JSONResponse(
                        {"detail": "Request body too large"}, status_code=413
                    )
            except ValueError:
                return JSONResponse(
                    {"detail": "Invalid Content-Length"}, status_code=400
                )

    # Rate limit the LLM-backed + public lab routes on GET and POST alike (the
    # public insight/analyze GETs must be throttled too, not only POSTs).
    if (
        _RATE_LIMIT_PER_MINUTE > 0
        and request.method in ("GET", "POST")
        and request.url.path.startswith(_RATE_LIMITED_PREFIXES)
    ):
        if not _rate_limit_ok(_client_key(request)):
            return JSONResponse(
                {"detail": "تم تجاوز الحد المسموح من الطلبات. حاول بعد قليل."},
                status_code=429,
                headers={"Retry-After": "60"},
            )

    return await call_next(request)


# ── Models ────────────────────────────────────────────────────────────────


class SearchRequest(BaseModel):
    query: str = Field(..., max_length=2000)
    top_k: int = Field(default=10, ge=1, le=100)
    mode: str = "hybrid"  # "hybrid", "dense", "sparse"
    journal_id: str | None = None
    section: str | None = None
    doc_id: str | None = None
    deduplicate: bool = True  # keep only the top chunk per document
    hyde: bool = False  # opt-in HyDE expansion for broader recall


class SearchResultItem(BaseModel):
    chunk_id: str
    doc_id: str
    text: str
    title: str
    section: str
    score: float
    chunk_index: int
    journal_id: str
    char_len: int
    # Score breakdown (PLAN B1): already computed in the reranker. Defaults keep
    # SynthesisRequest's inbound SearchResultItem payload backward-compatible.
    raw_score: float = 0.0
    lexical_score: float = 0.0
    title_score: float = 0.0
    # MARC bibliographic fields (PLAN B2): plural lists; null until the backfill.
    authors: list[str] | None = None
    year: str | None = None
    journal: str | None = None
    keywords: list[str] | None = None


class SearchResponse(BaseModel):
    query: str
    mode: str
    results: list[SearchResultItem]
    total: int
    search_ms: float
    low_confidence: bool = False
    warning: str | None = None
    suggestions: list[str] = []


# ── Routes ────────────────────────────────────────────────────────────────


@app.get("/api/health")
async def health():
    """Health check — verifies Qdrant connection."""
    try:
        searcher = get_searcher()
        info = searcher.client.get_collection(searcher.collection_name)
        return {
            "status": "ok",
            "collection": searcher.collection_name,
            "points_count": info.points_count,
        }
    except Exception as e:
        return {"status": "error", "detail": str(e)}


@app.get("/api/stats")
async def stats():
    """Return live collection stats: chunk count + unique doc count."""
    return await asyncio.to_thread(get_corpus_stats)


@app.post("/api/search", response_model=SearchResponse)
async def search(req: SearchRequest):
    """Run a hybrid/dense/sparse search."""
    if not req.query.strip():
        raise HTTPException(400, "Query cannot be empty")

    if req.mode not in ("hybrid", "dense", "sparse"):
        raise HTTPException(400, f"Invalid mode: {req.mode}")

    searcher = get_searcher()

    # Fetch more candidates when deduplicating so we can still return top_k unique docs
    fetch_k = min(req.top_k * 5, 100) if req.deduplicate else req.top_k

    # HyDE: use hypothetical document for embedding when no doc_id filter is active
    use_hyde = req.hyde and not req.doc_id

    t0 = time.time()
    if use_hyde:
        results = await asyncio.to_thread(
            searcher.search_with_hyde,
            req.query,
            top_k=fetch_k,
            mode=req.mode,
            journal_id=req.journal_id,
            section=req.section,
        )
    else:
        results = await asyncio.to_thread(
            searcher.search,
            req.query,
            top_k=fetch_k,
            mode=req.mode,
            journal_id=req.journal_id,
            section=req.section,
            doc_id=req.doc_id,
        )
    search_ms = round((time.time() - t0) * 1000, 1)

    if req.deduplicate:
        results = dedup_results(results, req.top_k)

    low_confidence = compute_low_confidence(results)

    warning = None
    if low_confidence:
        warning = (
            "هذه النتائج أولية وقد تحتوي على تطابقات موضوعية عامة. "
            "جرّب إيقاف HyDE أو تضييق الاستعلام أو استخدام كلمات أكثر تحديداً."
        )

    # When confidence is low, surface adjacent corpus topics ("هل تقصد") drawn
    # from the titles that did surface, so the user can pivot to a real query.
    suggestions: list[str] = []
    if low_confidence and results:
        seen_titles: set[str] = set()
        for r in results:
            title = (getattr(r, "title", "") or "").strip()
            if not title:
                continue
            # Trim overly long titles to a clickable-length phrase.
            phrase = title if len(title) <= 80 else title[:80].rsplit(" ", 1)[0] + "…"
            key = phrase.lower()
            if key in seen_titles:
                continue
            seen_titles.add(key)
            suggestions.append(phrase)
            if len(suggestions) >= 3:
                break

    return SearchResponse(
        query=req.query,
        mode=req.mode,
        results=[
            SearchResultItem(
                chunk_id=r.chunk_id,
                doc_id=r.doc_id,
                text=r.text,
                title=r.title,
                section=r.section,
                score=r.score,
                chunk_index=r.chunk_index,
                journal_id=r.journal_id,
                char_len=r.char_len,
                raw_score=r.raw_score,
                lexical_score=r.lexical_score,
                title_score=r.title_score,
                authors=getattr(r, "authors", None),
                year=getattr(r, "year", None),
                journal=getattr(r, "journal", None),
                keywords=getattr(r, "keywords", None),
            )
            for r in results
        ],
        total=len(results),
        search_ms=search_ms,
        low_confidence=low_confidence,
        warning=warning,
        suggestions=suggestions,
    )


# ── Search synthesis ──────────────────────────────────────────────────────


class SynthesisRequest(BaseModel):
    query: str = Field(..., max_length=2000)
    results: list[SearchResultItem] = Field(..., min_length=1, max_length=20)
    mode: Literal["fast", "advanced"] = "fast"
    max_documents: int = Field(default=5, ge=1, le=10)
    chunks_per_document: int = Field(default=4, ge=1, le=8)
    use_hyde: bool = False
    search_mode: Literal["hybrid", "dense", "sparse"] = "hybrid"
    journal_id: str | None = None
    section: str | None = None
    doc_id: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _normalize_legacy_fields(cls, data):
        """Accept the older frontend naming while the UI catches up."""
        if not isinstance(data, dict):
            return data

        payload = dict(data)
        if "mode" not in payload and "synthesis_mode" in payload:
            payload["mode"] = "advanced" if payload["synthesis_mode"] == "advanced" else "fast"
        return payload


@app.post("/api/search/synthesize")
async def synthesize(req: SynthesisRequest):
    """Stream a cross-document synthesis grounded in canonical search results."""
    if not req.query.strip():
        raise HTTPException(400, "Query cannot be empty")

    searcher = get_searcher()

    from backend.services.synthesis import stream_synthesis

    return StreamingResponse(
        stream_synthesis(
            searcher,
            req.query,
            [r.model_dump() for r in req.results],
            mode=req.mode,
            max_documents=req.max_documents,
            chunks_per_document=req.chunks_per_document,
            use_hyde=req.use_hyde,
            search_mode=req.search_mode,
            journal_id=req.journal_id,
            section=req.section,
            doc_id=req.doc_id,
        ),
        media_type="text/event-stream",
    )


# ── PDF serving ───────────────────────────────────────────────────────────

# _DOC_ID_RE, _doc_dir, load_doc_content_cached imported from backend.services.runtime

@app.get("/api/pdf/{doc_id}")
async def get_pdf(doc_id: str):
    """Serve a document PDF by its ID."""
    if not _DOC_ID_RE.match(doc_id):
        raise HTTPException(400, "Invalid document ID format")

    pdf_path = await ensure_doc_file_async(doc_id, f"{doc_id}.pdf")

    if pdf_path is None:
        raise HTTPException(404, "PDF not found")

    return FileResponse(str(pdf_path), media_type="application/pdf")


# ── Document OCR data ─────────────────────────────────────────────────────

# LRU cache for raster dimensions (avoids re-opening the PDF for every OCR request)
_RASTER_DIMS_CACHE_MAX = 100
_raster_dims_cache: OrderedDict[str, dict[int, tuple[int, int]]] = OrderedDict()

# LRU cache for the fully-assembled OCR pages, keyed by doc_id. The source OCR
# JSON is multi-MB (3-9MB); without this each /ocr request re-reads and re-parses
# it into a large Python structure. Bounded by doc count — keep modest since each
# entry can be sizeable.
_OCR_PAGES_CACHE_MAX = int(os.getenv("OCR_PAGES_CACHE_MAX", "24"))
_ocr_pages_cache: OrderedDict[str, list] = OrderedDict()
_ocr_pages_lock = threading.Lock()


def _get_raster_dims(pdf_path: Path) -> dict[int, tuple[int, int]]:
    """Return {pageNumber: (rasterWidth, rasterHeight)} for a PDF, using cache."""
    key = str(pdf_path)
    if key in _raster_dims_cache:
        _raster_dims_cache.move_to_end(key)
        return _raster_dims_cache[key]

    dims: dict[int, tuple[int, int]] = {}
    if pdf_path.is_file():
        try:
            doc = fitz.open(str(pdf_path))
            for i in range(len(doc)):
                page = doc[i]
                rw = round(page.rect.width * 200 / 72)
                rh = round(page.rect.height * 200 / 72)
                dims[i + 1] = (rw, rh)
            doc.close()
        except Exception:
            pass

    _raster_dims_cache[key] = dims
    if len(_raster_dims_cache) > _RASTER_DIMS_CACHE_MAX:
        _raster_dims_cache.popitem(last=False)
    return dims


def _load_ocr_data(json_path: Path, pdf_path: Path) -> list[dict]:
    """Synchronous: load OCR JSON and compute raster dimensions."""
    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)

    raster_dims = _get_raster_dims(pdf_path)

    pages = []
    for p in data.get("pages", []):
        pn = p.get("pageNumber", 0)
        rw, rh = raster_dims.get(pn, (0, 0))
        pages.append({
            "pageNumber": pn,
            "width": p.get("width"),
            "height": p.get("height"),
            "unit": p.get("unit", "inch"),
            "angle": p.get("angle", 0),
            "rasterWidth": rw,
            "rasterHeight": rh,
            "words": p.get("words", []),
            "lines": p.get("lines", []),
        })
    return pages


@app.get("/api/document/{doc_id}/ocr")
async def get_ocr(doc_id: str):
    """Return the OCR JSON for a document (pages, words, lines) with raster dims."""
    if not _DOC_ID_RE.match(doc_id):
        raise HTTPException(400, "Invalid document ID format")

    with _ocr_pages_lock:
        cached = _ocr_pages_cache.get(doc_id)
        if cached is not None:
            _ocr_pages_cache.move_to_end(doc_id)
    if cached is not None:
        return JSONResponse({"pages": cached})

    json_path = await ensure_doc_file_async(doc_id, f"{doc_id}.json")
    if json_path is None:
        raise HTTPException(404, "OCR JSON not found")

    pdf_path = await ensure_doc_file_async(doc_id, f"{doc_id}.pdf")
    # raster dims are best-effort — fall back to a non-existent path if no PDF
    pdf_arg = pdf_path if pdf_path is not None else _doc_dir(doc_id) / f"{doc_id}.pdf"
    pages = await asyncio.to_thread(_load_ocr_data, json_path, pdf_arg)

    with _ocr_pages_lock:
        _ocr_pages_cache[doc_id] = pages
        _ocr_pages_cache.move_to_end(doc_id)
        if len(_ocr_pages_cache) > _OCR_PAGES_CACHE_MAX:
            _ocr_pages_cache.popitem(last=False)
    return JSONResponse({"pages": pages})


# ── Page image rendering ──────────────────────────────────────────────────

# LRU in-memory cache for rendered page images (bounded at 200 entries)
_PAGE_IMAGE_CACHE_MAX = 200
_page_image_cache: OrderedDict[str, tuple[bytes, str]] = OrderedDict()


class _PageNotFoundError(Exception):
    def __init__(self, page_num: int, total: int):
        self.page_num = page_num
        self.total = total


def _render_page(pdf_path: str, page_index: int) -> bytes:
    """Synchronous: open PDF, render one page at 200 DPI, return WebP/PNG bytes."""
    doc = fitz.open(pdf_path)
    total = len(doc)
    if page_index < 0 or page_index >= total:
        doc.close()
        raise _PageNotFoundError(page_index + 1, total)
    page = doc[page_index]
    mat = fitz.Matrix(200 / 72, 200 / 72)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    doc.close()
    try:
        from PIL import Image
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        buf = BytesIO()
        img.save(buf, format="WEBP", quality=85)
        return buf.getvalue()
    except ImportError:
        return pix.tobytes("png")


@app.get("/api/document/{doc_id}/page/{page_num}/image")
async def get_page_image(doc_id: str, page_num: int):
    """Render and return a page image from the PDF."""
    if not _DOC_ID_RE.match(doc_id):
        raise HTTPException(400, "Invalid document ID format")
    if page_num < 1:
        raise HTTPException(400, "Page number must be >= 1")

    cache_key = f"{doc_id}:{page_num}"
    if cache_key in _page_image_cache:
        img_bytes, etag = _page_image_cache[cache_key]
        _page_image_cache.move_to_end(cache_key)
        return Response(content=img_bytes, media_type="image/webp",
                        headers={"ETag": etag, "Cache-Control": "public, max-age=86400"})

    pdf_path = await ensure_doc_file_async(doc_id, f"{doc_id}.pdf")
    if pdf_path is None:
        raise HTTPException(404, "PDF not found")

    try:
        img_bytes = await asyncio.to_thread(_render_page, str(pdf_path), page_num - 1)
    except _PageNotFoundError as e:
        raise HTTPException(404, f"Page {e.page_num} not found (document has {e.total} pages)")
    except Exception:
        raise HTTPException(500, "Failed to render page")

    etag = hashlib.md5(img_bytes[:1024]).hexdigest()
    _page_image_cache[cache_key] = (img_bytes, etag)
    if len(_page_image_cache) > _PAGE_IMAGE_CACHE_MAX:
        _page_image_cache.popitem(last=False)

    return Response(content=img_bytes, media_type="image/webp",
                    headers={"ETag": etag, "Cache-Control": "public, max-age=86400"})


# ── Chat (document-scoped LLM) ───────────────────────────────────────────


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(..., max_length=100_000)


class ChatRequest(BaseModel):
    doc_id: str
    message: str = Field(..., max_length=10_000)
    history: list[ChatMessage] = Field(default=[], max_length=40)
    compare_doc_ids: list[str] = Field(default=[], max_length=3)


# _load_doc_content_cached is imported from backend.services.runtime


@app.post("/api/chat")
async def chat(req: ChatRequest):
    """Stream a chat response grounded in one or more documents."""
    if not _DOC_ID_RE.match(req.doc_id):
        raise HTTPException(400, "Invalid document ID format")

    if not req.message.strip():
        raise HTTPException(400, "Message cannot be empty")

    # Validate compare doc IDs
    for cid in req.compare_doc_ids:
        if not _DOC_ID_RE.match(cid):
            raise HTTPException(400, f"Invalid compare document ID format: {cid}")

    json_path = await ensure_doc_file_async(req.doc_id, f"{req.doc_id}.json")
    if json_path is None:
        raise HTTPException(404, "Document not found")

    content = await asyncio.to_thread(_load_doc_content_cached, json_path)

    if not content or not content.strip():
        raise HTTPException(422, "Document has no extractable text content")

    # Load comparison documents if any
    compare_contents: list[tuple[str, str]] = []
    missing_compare: list[str] = []
    for cid in req.compare_doc_ids:
        if cid == req.doc_id:
            continue  # skip duplicates
        cpath = await ensure_doc_file_async(cid, f"{cid}.json")
        if cpath is not None:
            ccontent = await asyncio.to_thread(_load_doc_content_cached, cpath)
            if ccontent and ccontent.strip():
                compare_contents.append((cid, ccontent))
            else:
                missing_compare.append(cid)
        else:
            missing_compare.append(cid)

    if req.compare_doc_ids and not compare_contents and missing_compare:
        raise HTTPException(404, f"Comparison document(s) not found: {', '.join(missing_compare)}")

    history = [{"role": m.role, "content": m.content} for m in req.history]

    from backend.services.chat import stream_chat, stream_chat_multi

    if compare_contents:
        return StreamingResponse(
            stream_chat_multi(content, compare_contents, req.message, history),
            media_type="text/event-stream",
        )

    return StreamingResponse(
        stream_chat(content, req.message, history),
        media_type="text/event-stream",
    )


# ── Document analysis (deep insights) ────────────────────────────────────

# LRU cache for analysis results (avoids re-analyzing the same doc)
_ANALYSIS_CACHE_MAX = 30
_analysis_cache: OrderedDict[str, str] = OrderedDict()


@app.get("/api/analyze/{doc_id}")
async def analyze(doc_id: str):
    """Return a structured deep analysis of a document."""
    if not _DOC_ID_RE.match(doc_id):
        raise HTTPException(400, "Invalid document ID format")

    # Check cache first
    if doc_id in _analysis_cache:
        _analysis_cache.move_to_end(doc_id)
        return JSONResponse(
            content=json.loads(_analysis_cache[doc_id]),
            headers={"X-Cache": "HIT"},
        )

    json_path = await ensure_doc_file_async(doc_id, f"{doc_id}.json")
    if json_path is None:
        raise HTTPException(404, "Document not found")

    content = await asyncio.to_thread(_load_doc_content_cached, json_path)
    if not content or not content.strip():
        raise HTTPException(422, "Document has no extractable text content")

    from backend.services.chat import analyze_document

    try:
        raw = await asyncio.to_thread(analyze_document, content)
        # Strip markdown fences if model wraps them
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[-1]
        if cleaned.endswith("```"):
            cleaned = cleaned.rsplit("```", 1)[0]
        cleaned = cleaned.strip()
        parsed = json.loads(cleaned)
    except (json.JSONDecodeError, Exception) as exc:
        logger.exception("Analysis parse error: %s", exc)
        raise HTTPException(500, "حدث خطأ أثناء تحليل المستند")

    # Cache the result
    _analysis_cache[doc_id] = json.dumps(parsed, ensure_ascii=False)
    if len(_analysis_cache) > _ANALYSIS_CACHE_MAX:
        _analysis_cache.popitem(last=False)

    return JSONResponse(content=parsed)


# ── Corpus-wide chat (multi-turn, retrieval across the whole collection) ──

_CORPUS_HISTORY_LIMIT = 20
# Default chunks retrieved per turn; "more sources" raises this client-side.
_CORPUS_RETRIEVE_TOP_K = 10


class CorpusChatRequest(BaseModel):
    conversation_id: str | None = None
    message: str = Field(..., max_length=10_000)
    # "Regenerate": re-answer the last user turn in place (drops the stale
    # assistant answer) instead of appending a new exchange.
    regenerate: bool = False
    # "More sources": retrieve more chunks for a broader answer.
    retrieve_top_k: int | None = Field(default=None, ge=1, le=40)
    # "Deep": decompose the question into sub-queries and retrieve for each
    # (agentic multi-step retrieval) for broader coverage on complex questions.
    deep: bool = False


@app.post("/api/chat/corpus")
async def chat_corpus(req: CorpusChatRequest):
    """Stream a corpus-wide grounded chat answer with persistent history."""
    message = req.message.strip()
    if not message:
        raise HTTPException(400, "Message cannot be empty")

    from backend.services import conversation_store as store
    from backend.services.corpus_chat import stream_corpus_chat

    # Resolve or create the conversation (SQLite I/O offloaded off the event loop).
    conversation_id = req.conversation_id
    conv = (
        await asyncio.to_thread(store.get_conversation, conversation_id)
        if conversation_id
        else None
    )
    if conv is None:
        title = message[:60].strip() or "محادثة جديدة"
        conversation_id = await asyncio.to_thread(store.create_conversation, title)
        history: list[dict[str, str]] = []
    else:
        conversation_id = conv["id"]
        # Pass the full thread; corpus_chat windows recent turns verbatim and
        # summarises older ones internally for long-conversation memory.
        history = [
            {"role": m["role"], "content": m["content"]}
            for m in conv["messages"]
            if m["role"] in ("user", "assistant")
        ]

    if req.regenerate and conv is not None:
        # Re-answer the existing last user turn: drop the stale assistant reply
        # and the trailing user turn from history (it becomes the live message),
        # and do NOT persist a duplicate user message.
        await asyncio.to_thread(store.delete_last_assistant_message, conversation_id)
        if history and history[-1]["role"] == "assistant":
            history.pop()
        if history and history[-1]["role"] == "user":
            history.pop()
    else:
        # Persist the user message before streaming.
        await asyncio.to_thread(store.add_message, conversation_id, "user", message)

    searcher = get_searcher()

    async def event_stream():
        yield f"data: {json.dumps({'conversation_id': conversation_id})}\n\n"

        answer_parts: list[str] = []
        captured_sources: list[dict] | None = None
        captured_meta: dict | None = None
        captured_followups: list[str] | None = None

        top_k = req.retrieve_top_k or _CORPUS_RETRIEVE_TOP_K
        async for line in stream_corpus_chat(
            message, history, searcher, retrieve_top_k=top_k, deep=req.deep
        ):
            # Inspect the JSON payload to accumulate tokens + sources + extras
            # for persistence.
            payload = line[len("data: "):].strip() if line.startswith("data: ") else ""
            if payload and payload != "[DONE]":
                try:
                    obj = json.loads(payload)
                except (json.JSONDecodeError, ValueError):
                    obj = None
                if isinstance(obj, dict):
                    if "token" in obj:
                        answer_parts.append(obj["token"])
                    elif "sources" in obj:
                        captured_sources = obj["sources"]
                    elif "meta" in obj:
                        captured_meta = obj["meta"]
                    elif "followups" in obj:
                        captured_followups = obj["followups"]
            yield line

        assistant_text = "".join(answer_parts)
        if assistant_text:
            meta_payload: dict = dict(captured_meta) if captured_meta else {}
            if captured_followups:
                meta_payload["followups"] = captured_followups
            try:
                await asyncio.to_thread(
                    store.add_message,
                    conversation_id,
                    "assistant",
                    assistant_text,
                    captured_sources,
                    meta_payload or None,
                )
            except Exception:
                logger.exception("Failed to persist assistant message")

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            # Disable proxy/Nginx response buffering so SSE tokens flush live.
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


class RenameConversationRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=300)


@app.get("/api/conversations")
async def list_conversations_route():
    """List all conversations (most-recently-updated first)."""
    from backend.services import conversation_store as store

    return JSONResponse(content=await asyncio.to_thread(store.list_conversations))


@app.get("/api/conversations/{conversation_id}")
async def get_conversation_route(conversation_id: str):
    """Return a single conversation with its messages."""
    from backend.services import conversation_store as store

    conv = await asyncio.to_thread(store.get_conversation, conversation_id)
    if conv is None:
        raise HTTPException(404, "Conversation not found")
    return JSONResponse(content=conv)


@app.patch("/api/conversations/{conversation_id}")
async def rename_conversation_route(
    conversation_id: str, req: RenameConversationRequest
):
    """Rename a conversation."""
    from backend.services import conversation_store as store

    renamed = await asyncio.to_thread(
        store.rename_conversation, conversation_id, req.title.strip()
    )
    if not renamed:
        raise HTTPException(404, "Conversation not found")
    return JSONResponse(content={"ok": True})


@app.delete("/api/conversations/{conversation_id}")
async def delete_conversation_route(conversation_id: str):
    """Delete a conversation and its messages."""
    from backend.services import conversation_store as store

    deleted = await asyncio.to_thread(store.delete_conversation, conversation_id)
    if not deleted:
        raise HTTPException(404, "Conversation not found")
    return JSONResponse(content={"ok": True})


# ── Admin / Vector-Inspector console ──────────────────────────────────────
# Read-only admin API under /api/admin/* (own username/password auth).
from backend.routers.admin import router as _admin_router
from backend.routers.insights import router as _insights_router

app.include_router(_admin_router)
app.include_router(_insights_router)  # public read-only insight surface (PLAN B3)


# ── MCP server mount ──────────────────────────────────────────────────────
#
# Mounted last so all existing routes take precedence.
# The lifespan (defined near the top) wires the session-manager lifecycle.
#
# phase 2: OAuth — replace X-API-Key with OAuth 2.1/Entra ID when targeting
#           the Microsoft gallery submission.

if _MCP_ENABLED:
    from starlette.types import ASGIApp, Receive, Scope, Send

    class _MCPPathNormalizer:
        """Rewrite empty path to '/' before passing to the MCP sub-app.

        When FastAPI mounts the MCP sub-app at '/mcp' and a client sends
        POST /mcp (no trailing slash), Starlette strips the prefix and
        passes path='' to the sub-app.  This wrapper ensures that the
        canonical POST /mcp/ endpoint also handles the bare /mcp form
        inside the sub-app routing layer.
        """
        def __init__(self, app: ASGIApp) -> None:
            self._app = app

        async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
            if scope.get("type") == "http" and not scope.get("path"):
                scope = {**scope, "path": "/", "raw_path": b"/"}
            await self._app(scope, receive, send)

    app.mount("/mcp", _MCPPathNormalizer(_mcp_asgi_app))
