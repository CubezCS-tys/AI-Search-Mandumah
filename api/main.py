"""
Al-Manthooma Search API.

Thin FastAPI layer over the pipeline search module.

Run:
    uvicorn api.main:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from io import BytesIO
from pathlib import Path

import fitz  # PyMuPDF
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, JSONResponse
from pydantic import BaseModel

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

# ── Lazy-loaded searcher (avoid loading BGE-M3 at import time) ────────────

_searcher = None


def get_searcher():
    global _searcher
    if _searcher is None:
        from pipeline.search import Searcher

        _searcher = Searcher(
            qdrant_url=os.getenv("QDRANT_URL", "http://localhost:6333"),
            collection_name=os.getenv("COLLECTION_NAME", "academic_articles"),
        )
    return _searcher


# ── Models ────────────────────────────────────────────────────────────────


class SearchRequest(BaseModel):
    query: str
    top_k: int = 10
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


@app.get("/api/pdf/{doc_id}")
async def get_pdf(doc_id: str):
    """Serve a document PDF by its ID."""
    if not _DOC_ID_RE.match(doc_id):
        raise HTTPException(400, "Invalid document ID format")

    journal_id = doc_id[:4]
    pdf_path = os.path.join(
        "output", f"output_{journal_id}", doc_id, f"{doc_id}.pdf"
    )

    if not os.path.isfile(pdf_path):
        raise HTTPException(404, "PDF not found")

    return FileResponse(pdf_path, media_type="application/pdf")


# ── Document OCR data ─────────────────────────────────────────────────────

def _doc_dir(doc_id: str) -> str:
    journal_id = doc_id[:4]
    return os.path.join("output", f"output_{journal_id}", doc_id)


@app.get("/api/document/{doc_id}/ocr")
async def get_ocr(doc_id: str):
    """Return the OCR JSON for a document (pages, words, lines) with raster dims."""
    if not _DOC_ID_RE.match(doc_id):
        raise HTTPException(400, "Invalid document ID format")

    json_path = os.path.join(_doc_dir(doc_id), f"{doc_id}.json")
    if not os.path.isfile(json_path):
        raise HTTPException(404, "OCR JSON not found")

    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Compute raster dimensions from PDF page sizes (no actual rendering needed)
    pdf_path = os.path.join(_doc_dir(doc_id), f"{doc_id}.pdf")
    raster_dims: dict[int, tuple[int, int]] = {}
    if os.path.isfile(pdf_path):
        try:
            doc = fitz.open(pdf_path)
            for i in range(len(doc)):
                page = doc[i]
                # Match the 200/72 matrix used in the image endpoint
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

    return JSONResponse({"pages": pages})


# ── Page image rendering ──────────────────────────────────────────────────

# Simple in-memory cache for rendered page images
_page_image_cache: dict[str, tuple[bytes, str]] = {}


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
        return Response(content=img_bytes, media_type="image/webp",
                        headers={"ETag": etag, "Cache-Control": "public, max-age=86400"})

    pdf_path = os.path.join(_doc_dir(doc_id), f"{doc_id}.pdf")
    if not os.path.isfile(pdf_path):
        raise HTTPException(404, "PDF not found")

    try:
        doc = fitz.open(pdf_path)
    except Exception:
        raise HTTPException(500, "Failed to open PDF")

    page_index = page_num - 1
    if page_index < 0 or page_index >= len(doc):
        doc.close()
        raise HTTPException(404, f"Page {page_num} not found (document has {len(doc)} pages)")

    page = doc[page_index]
    # Render at 200 DPI for good quality
    mat = fitz.Matrix(200 / 72, 200 / 72)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    doc.close()

    # Convert to WebP using Pillow for smaller size
    try:
        from PIL import Image
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        buf = BytesIO()
        img.save(buf, format="WEBP", quality=85)
        img_bytes = buf.getvalue()
    except ImportError:
        # Fallback to PNG
        img_bytes = pix.tobytes("png")

    etag = hashlib.md5(img_bytes[:1024]).hexdigest()
    _page_image_cache[cache_key] = (img_bytes, etag)

    return Response(content=img_bytes, media_type="image/webp",
                    headers={"ETag": etag, "Cache-Control": "public, max-age=86400"})
