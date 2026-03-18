"""
Al-Manthooma Search API.

Thin FastAPI layer over the pipeline search module.

Run:
    uvicorn api.main:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations

import logging
import os
import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logger = logging.getLogger(__name__)

app = FastAPI(title="Al-Manthooma Search API", version="0.1.0")

# CORS — allow all origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
