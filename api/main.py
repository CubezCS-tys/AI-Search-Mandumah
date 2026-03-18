"""
Al-Manthooma Search API.

Thin FastAPI layer over the pipeline search module.

Run:
    uvicorn api.main:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations

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
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

app = FastAPI(title="Al-Manthooma Search API", version="0.1.0")

# CORS — allow Next.js dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
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
                from services.search import Searcher

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


@app.post("/api/search", response_model=SearchResponse)
async def search(req: SearchRequest):
    """Run a hybrid/dense/sparse search."""
    if not req.query.strip():
        raise HTTPException(400, "Query cannot be empty")

    if req.mode not in ("hybrid", "dense", "sparse"):
        raise HTTPException(400, f"Invalid mode: {req.mode}")

    searcher = get_searcher()

    t0 = time.time()
    results = searcher.search(
        req.query,
        top_k=req.top_k,
        mode=req.mode,
        journal_id=req.journal_id,
        section=req.section,
        doc_id=req.doc_id,
    )
    search_ms = round((time.time() - t0) * 1000, 1)

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


def _load_ocr_data(json_path: Path, pdf_path: Path) -> list[dict]:
    """Synchronous: load OCR JSON and compute raster dimensions."""
    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)

    raster_dims: dict[int, tuple[int, int]] = {}
    if pdf_path.is_file():
        try:
            doc = fitz.open(str(pdf_path))
            for i in range(len(doc)):
                page = doc[i]
                rw = round(page.rect.width * 200 / 72)
                rh = round(page.rect.height * 200 / 72)
                raster_dims[i + 1] = (rw, rh)
            doc.close()
        except Exception:
            pass

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
    content: str


class ChatRequest(BaseModel):
    doc_id: str
    message: str
    history: list[ChatMessage] = Field(default=[], max_length=40)


def _load_doc_content(json_path: Path) -> str:
    """Synchronous: read and return the content field from a document JSON."""
    with open(json_path, encoding="utf-8") as f:
        return json.load(f).get("content", "")


@app.post("/api/chat")
async def chat(req: ChatRequest):
    """Stream a chat response grounded in a single document."""
    if not _DOC_ID_RE.match(req.doc_id):
        raise HTTPException(400, "Invalid document ID format")

    if not req.message.strip():
        raise HTTPException(400, "Message cannot be empty")

    json_path = _doc_dir(req.doc_id) / f"{req.doc_id}.json"
    if not json_path.is_file():
        raise HTTPException(404, "Document not found")

    content = await asyncio.to_thread(_load_doc_content, json_path)
    history = [{"role": m.role, "content": m.content} for m in req.history]

    from services.chat import stream_chat

    return StreamingResponse(
        stream_chat(content, req.message, history),
        media_type="text/event-stream",
    )
