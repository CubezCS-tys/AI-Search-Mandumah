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

app = FastAPI(title="Al-Manthooma Search API", version="0.1.0")

# CORS — allow Next.js dev server and any ngrok tunnel
_EXTRA_ORIGINS = [
    o.strip()
    for o in os.getenv("EXTRA_CORS_ORIGINS", "").split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Optional API key guard ────────────────────────────────────────────────

_API_KEY = os.getenv("API_KEY")


@app.middleware("http")
async def _api_key_guard(request: Request, call_next):
    """If API_KEY env var is set, require a matching X-API-Key header."""
    if _API_KEY and request.headers.get("X-API-Key") != _API_KEY:
        return Response(
            content="Unauthorized", status_code=401, media_type="text/plain"
        )
    return await call_next(request)


# ── Lazy-loaded searcher (avoid loading BGE-M3 at import time) ────────────

_searcher = None
_searcher_lock = threading.Lock()


def get_searcher():
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


# ── Models ────────────────────────────────────────────────────────────────


class SearchRequest(BaseModel):
    query: str
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


class SearchResponse(BaseModel):
    query: str
    mode: str
    results: list[SearchResultItem]
    total: int
    search_ms: float
    low_confidence: bool = False
    warning: str | None = None


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
    try:
        searcher = get_searcher()
        info = searcher.client.get_collection(searcher.collection_name)
        chunks = info.points_count or 0

        # Count unique doc_ids via scroll
        doc_ids: set[str] = set()
        offset = None
        while True:
            points, offset = searcher.client.scroll(
                collection_name=searcher.collection_name,
                limit=250,
                offset=offset,
                with_payload=["doc_id"],
                with_vectors=False,
            )
            for pt in points:
                did = (pt.payload or {}).get("doc_id")
                if did:
                    doc_ids.add(did)
            if offset is None:
                break

        return {"chunks": chunks, "documents": len(doc_ids)}
    except Exception as e:
        return {"chunks": 0, "documents": 0, "error": str(e)}


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
        seen: dict[str, object] = {}
        for r in results:
            if r.doc_id not in seen:
                seen[r.doc_id] = r
        results = list(seen.values())[:req.top_k]

    if results:
        top_score = results[0].score
        top_window = results[: min(3, len(results))]
        avg_lexical = sum(getattr(r, "lexical_score", 0.0) for r in top_window) / len(top_window)
        low_confidence = top_score < 0.34 or avg_lexical < 0.14
    else:
        low_confidence = True

    warning = None
    if low_confidence:
        warning = (
            "هذه النتائج أولية وقد تحتوي على تطابقات موضوعية عامة. "
            "جرّب إيقاف HyDE أو تضييق الاستعلام أو استخدام كلمات أكثر تحديداً."
        )

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
            )
            for r in results
        ],
        total=len(results),
        search_ms=search_ms,
        low_confidence=low_confidence,
        warning=warning,
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

_DOC_ID_RE = re.compile(r"^\d{4}-\d{3}-\d{3}-\d{3}$")
_OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", str(Path(__file__).parent.parent / "output")))


@app.get("/api/pdf/{doc_id}")
async def get_pdf(doc_id: str):
    """Serve a document PDF by its ID."""
    if not _DOC_ID_RE.match(doc_id):
        raise HTTPException(400, "Invalid document ID format")

    pdf_path = _doc_dir(doc_id) / f"{doc_id}.pdf"

    if not pdf_path.is_file():
        raise HTTPException(404, "PDF not found")

    return FileResponse(str(pdf_path), media_type="application/pdf")


# ── Document OCR data ─────────────────────────────────────────────────────

def _doc_dir(doc_id: str) -> Path:
    journal_id = doc_id[:4]
    return _OUTPUT_DIR / f"output_{journal_id}" / doc_id


# LRU cache for raster dimensions (avoids re-opening the PDF for every OCR request)
_RASTER_DIMS_CACHE_MAX = 100
_raster_dims_cache: OrderedDict[str, dict[int, tuple[int, int]]] = OrderedDict()


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

    doc_path = _doc_dir(doc_id)
    json_path = doc_path / f"{doc_id}.json"
    if not json_path.is_file():
        raise HTTPException(404, "OCR JSON not found")

    pages = await asyncio.to_thread(_load_ocr_data, json_path, doc_path / f"{doc_id}.pdf")
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

    pdf_path = _doc_dir(doc_id) / f"{doc_id}.pdf"
    if not pdf_path.is_file():
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


def _load_doc_content(json_path: Path) -> str:
    """Synchronous: read and return the content field from a document JSON."""
    with open(json_path, encoding="utf-8") as f:
        return json.load(f).get("content", "")


# LRU cache for document content (avoids re-reading JSON on every chat message)
_DOC_CONTENT_CACHE_MAX = 50
_doc_content_cache: OrderedDict[str, str] = OrderedDict()


def _load_doc_content_cached(json_path: Path) -> str:
    """Cached wrapper around _load_doc_content."""
    key = str(json_path)
    if key in _doc_content_cache:
        _doc_content_cache.move_to_end(key)
        return _doc_content_cache[key]
    content = _load_doc_content(json_path)
    _doc_content_cache[key] = content
    if len(_doc_content_cache) > _DOC_CONTENT_CACHE_MAX:
        _doc_content_cache.popitem(last=False)
    return content


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

    json_path = _doc_dir(req.doc_id) / f"{req.doc_id}.json"
    if not json_path.is_file():
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
        cpath = _doc_dir(cid) / f"{cid}.json"
        if cpath.is_file():
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

    json_path = _doc_dir(doc_id) / f"{doc_id}.json"
    if not json_path.is_file():
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
