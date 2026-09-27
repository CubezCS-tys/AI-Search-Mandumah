"""
Admin / Vector-Inspector API (`/api/admin/*`).

A read-only console over the live Qdrant collection(s): browse documents, drill
into individual chunks and their dense + sparse vectors, debug retrieval
(dense vs sparse vs hybrid), and view a 2-D PCA projection of the vector space.

All routes except ``/login`` require a valid bearer token (see
:mod:`backend.services.admin_auth`). Talks to whatever Qdrant ``QDRANT_URL``
points at — including a remote bare-metal instance — via the shared client.
"""

from __future__ import annotations

import logging
import math
import os
import threading
import time
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field

from backend.services.admin_auth import check_credentials, make_token, verify_token
from backend.services.runtime import get_searcher

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin", tags=["admin"])

DEFAULT_COLLECTION = os.getenv("COLLECTION_NAME", "academic_articles")
_QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:6333")

# Cap how many vectors we pull for the PCA projection (SVD cost + payload size).
_MAX_PROJECTION_SAMPLE = 2000


# ── Auth plumbing ─────────────────────────────────────────────────────────


def require_admin(authorization: Optional[str] = Header(None)) -> str:
    """FastAPI dependency: validate the ``Authorization: Bearer <token>`` header."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    sub = verify_token(authorization.split(" ", 1)[1].strip())
    if not sub:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return sub


class LoginRequest(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(body: LoginRequest):
    """Exchange admin credentials for a signed bearer token."""
    if not check_credentials(body.username, body.password):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    from backend.services.admin_auth import TOKEN_TTL

    return {
        "token": make_token(body.username),
        "username": body.username,
        "expires_in": TOKEN_TTL,
    }


@router.get("/me")
def me(user: str = Depends(require_admin)):
    return {"username": user}


# ── Qdrant client / per-collection Searcher cache ─────────────────────────


def _client():
    """Shared qdrant client (collection-independent — usable for any name)."""
    return get_searcher().client


def _legacy_dense_search(collection: str, dense_vector, limit: int) -> list[dict]:
    """Dense kNN via the legacy ``/points/search`` REST endpoint.

    Qdrant 1.7.x has no Query API (``query_points`` 404s) and qdrant-client 1.17
    dropped ``.search``, so we hit the REST endpoint directly. Returns a list of
    ``{"id", "score", "payload"}`` dicts.
    """
    import requests

    resp = requests.post(
        f"{_QDRANT_URL}/collections/{collection}/points/search",
        json={
            "vector": {"name": "dense", "vector": list(dense_vector)},
            "limit": limit,
            "with_payload": True,
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json().get("result", [])


_searchers: dict[str, object] = {}
_searchers_lock = threading.Lock()


def _searcher_for(collection: str):
    """Return a cached :class:`Searcher` bound to *collection* (lazy embedder)."""
    s = _searchers.get(collection)
    if s is None:
        with _searchers_lock:
            s = _searchers.get(collection)
            if s is None:
                from backend.services.search import Searcher

                s = Searcher(qdrant_url=_QDRANT_URL, collection_name=collection)
                _searchers[collection] = s
    return s


# ── TTL cache for the (heavy) full-scroll aggregation ─────────────────────
# Qdrant < 1.12 has no server-side facet API (and qdrant-client 1.17 talking to
# an old server gets a 404), so we aggregate doc_id / journal / section counts
# client-side via one payload-only scroll, cached to amortise the cost.

from collections import Counter

_agg_cache: dict[str, tuple[float, dict]] = {}
_AGG_TTL = 600.0  # 10 min — corpus is static between ingests; the full scroll is ~50s


def _aggregate(collection: str) -> dict:
    """One payload-only scroll → doc/journal/section aggregates, cached 120s.

    Returns ``{"docs": [(doc_id, chunk_count), ...] sorted by doc_id,
    "journals": Counter, "sections": Counter}``. Replaces the server-side
    facet API, which is unavailable on Qdrant 1.7.x.
    """
    now = time.time()
    cached = _agg_cache.get(collection)
    if cached and (now - cached[0]) < _AGG_TTL:
        return cached[1]

    client = _client()
    doc_counts: dict[str, int] = {}
    journals: Counter = Counter()
    sections: Counter = Counter()
    next_off = None
    while True:
        pts, next_off = client.scroll(
            collection_name=collection,
            limit=10000,
            offset=next_off,
            with_payload=["doc_id", "journal", "journal_id", "section"],
            with_vectors=False,
        )
        for p in pts:
            pl = p.payload or {}
            did = pl.get("doc_id")
            if did is not None:
                doc_counts[str(did)] = doc_counts.get(str(did), 0) + 1
            jour = pl.get("journal") or pl.get("journal_id")
            if jour:
                journals[str(jour)] += 1
            sect = pl.get("section")
            if sect:
                sections[str(sect)] += 1
        if next_off is None:
            break

    result = {"docs": sorted(doc_counts.items()), "journals": journals, "sections": sections}
    _agg_cache[collection] = (now, result)
    return result


def _doc_facet(collection: str) -> list[tuple[str, int]]:
    """``[(doc_id, chunk_count), ...]`` sorted by doc_id (via cached aggregation)."""
    return _aggregate(collection)["docs"]


def _safe_dump(obj):
    """Best-effort JSON-friendly dump of a qdrant pydantic model."""
    for attr in ("model_dump", "dict"):
        fn = getattr(obj, attr, None)
        if callable(fn):
            try:
                return fn(mode="json") if attr == "model_dump" else fn()
            except TypeError:
                try:
                    return fn()
                except Exception:
                    pass
            except Exception:
                pass
    return str(obj)


# ── Collections & stats ───────────────────────────────────────────────────


@router.get("/collections")
def collections(user: str = Depends(require_admin)):
    """List Qdrant collections with point counts."""
    client = _client()
    out = []
    for c in client.get_collections().collections:
        entry = {"name": c.name}
        try:
            info = client.get_collection(c.name)
            entry["points"] = info.points_count
            entry["status"] = str(info.status)
        except Exception as e:  # noqa: BLE001
            entry["error"] = str(e)
        out.append(entry)
    out.sort(key=lambda e: e["name"])
    return {"collections": out, "default": DEFAULT_COLLECTION, "qdrant_url": _QDRANT_URL}


@router.get("/collection")
def collection_info(
    name: str = Query(default=DEFAULT_COLLECTION),
    user: str = Depends(require_admin),
):
    """Detailed config + stats for a single collection."""
    client = _client()
    try:
        info = client.get_collection(name)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=404, detail=f"Collection not found: {e}")

    params = info.config.params

    # Dense vector params (named "dense", may also be a bare VectorParams).
    dense = None
    vectors = getattr(params, "vectors", None)
    dv = vectors.get("dense") if isinstance(vectors, dict) else vectors
    if dv is not None:
        dense = {
            "size": getattr(dv, "size", None),
            "distance": str(getattr(dv, "distance", "")),
            "on_disk": getattr(dv, "on_disk", None),
        }

    sparse = None
    sv = getattr(params, "sparse_vectors", None)
    if isinstance(sv, dict) and sv:
        spv = next(iter(sv.values()))
        modifier = getattr(spv, "modifier", None)
        sparse = {"names": list(sv.keys()), "modifier": str(modifier) if modifier else None}

    quant = None
    qc = getattr(info.config, "quantization_config", None)
    if qc is not None:
        scalar = getattr(qc, "scalar", None)
        if scalar is not None:
            quant = {
                "type": f"scalar/{getattr(scalar, 'type', '')}",
                "quantile": getattr(scalar, "quantile", None),
                "always_ram": getattr(scalar, "always_ram", None),
            }
        else:
            quant = {"type": _safe_dump(qc)}

    hnsw = None
    hc = getattr(info.config, "hnsw_config", None)
    if hc is not None:
        hnsw = {
            "m": getattr(hc, "m", None),
            "ef_construct": getattr(hc, "ef_construct", None),
            "on_disk": getattr(hc, "on_disk", None),
        }

    return {
        "name": name,
        "status": str(info.status),
        "points_count": info.points_count,
        "segments_count": info.segments_count,
        "indexed_vectors_count": info.indexed_vectors_count,
        "dense": dense,
        "sparse": sparse,
        "quantization": quant,
        "hnsw": hnsw,
        "optimizer_status": str(getattr(info, "optimizer_status", "")),
    }


@router.get("/overview")
def overview(
    collection: str = Query(default=DEFAULT_COLLECTION),
    sample: int = Query(default=1500, ge=100, le=5000),
    user: str = Depends(require_admin),
):
    """Distribution stats: docs, top journals, sections, chunk-length histogram."""
    client = _client()
    agg = _aggregate(collection)
    docs = agg["docs"]
    total_chunks = sum(c for _, c in docs)

    # Journal & section breakdowns from the same client-side aggregation
    # (Qdrant 1.7.x has no facet API). Counts are per-chunk, matching facet.
    def _top(counter: Counter, limit: int = 15):
        return [{"value": v, "count": c} for v, c in counter.most_common(limit)]

    # Chunk-length histogram from a payload-only sample scroll.
    points, _ = client.scroll(
        collection_name=collection,
        limit=sample,
        with_payload=["char_len"],
        with_vectors=False,
    )
    lengths = [int(p.payload.get("char_len", 0)) for p in points if p.payload]
    bins = [0, 400, 800, 1200, 1600, 2000, 2400, 1_000_000]
    labels = ["<400", "400-800", "800-1200", "1200-1600", "1600-2000", "2000-2400", "2400+"]
    hist = [0] * len(labels)
    for ln in lengths:
        for i in range(len(labels)):
            if bins[i] <= ln < bins[i + 1]:
                hist[i] += 1
                break
    histogram = [{"label": labels[i], "count": hist[i]} for i in range(len(labels))]
    avg_len = round(sum(lengths) / len(lengths)) if lengths else 0

    return {
        "collection": collection,
        "documents": len(docs),
        "chunks": total_chunks,
        "avg_chunks_per_doc": round(total_chunks / len(docs), 1) if docs else 0,
        "avg_char_len": avg_len,
        "char_len_histogram": histogram,
        "histogram_sample": len(lengths),
        "top_journals": _top(agg["journals"]),
        "top_sections": _top(agg["sections"]),
    }


# ── Document browser ──────────────────────────────────────────────────────


@router.get("/documents")
def documents(
    collection: str = Query(default=DEFAULT_COLLECTION),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=25, ge=1, le=100),
    q: Optional[str] = Query(default=None),
    user: str = Depends(require_admin),
):
    """Paginated list of unique documents (by doc_id) with a representative title."""
    client = _client()
    from qdrant_client import models

    docs = _doc_facet(collection)
    if q:
        ql = q.strip().lower()
        docs = [d for d in docs if ql in d[0].lower()]
    total = len(docs)
    page = docs[offset : offset + limit]

    results = []
    for doc_id, count in page:
        meta = {}
        try:
            pts, _ = client.scroll(
                collection_name=collection,
                scroll_filter=models.Filter(
                    must=[models.FieldCondition(key="doc_id", match=models.MatchValue(value=doc_id))]
                ),
                limit=1,
                with_payload=True,
                with_vectors=False,
            )
            if pts:
                meta = pts[0].payload or {}
        except Exception:  # noqa: BLE001
            pass
        results.append(
            {
                "doc_id": doc_id,
                "chunks": count,
                "title": meta.get("title"),
                "journal": meta.get("journal") or meta.get("journal_id"),
                "year": meta.get("year"),
                "authors": meta.get("authors"),
            }
        )

    return {"documents": results, "total": total, "offset": offset, "limit": limit}


@router.get("/documents/{doc_id}/chunks")
def document_chunks(
    doc_id: str,
    collection: str = Query(default=DEFAULT_COLLECTION),
    user: str = Depends(require_admin),
):
    """All chunks for a document, in chunk_index order (payload only)."""
    client = _client()
    from qdrant_client import models

    flt = models.Filter(
        must=[models.FieldCondition(key="doc_id", match=models.MatchValue(value=doc_id))]
    )
    collected = []
    next_off = None
    while True:
        pts, next_off = client.scroll(
            collection_name=collection,
            scroll_filter=flt,
            limit=256,
            offset=next_off,
            with_payload=True,
            with_vectors=False,
        )
        collected.extend(pts)
        if next_off is None:
            break
    if not collected:
        raise HTTPException(status_code=404, detail="No chunks for that doc_id")

    collected.sort(key=lambda p: (p.payload or {}).get("chunk_index", 0))
    title = (collected[0].payload or {}).get("title")
    chunks = [{"point_id": str(p.id), **(p.payload or {})} for p in collected]
    return {"doc_id": doc_id, "title": title, "count": len(chunks), "chunks": chunks}


# ── Chunk / point inspector ───────────────────────────────────────────────


def _split_vectors(vector):
    """Return (dense_list, sparse_obj) from a retrieved point's `vector` field."""
    if isinstance(vector, dict):
        return vector.get("dense"), vector.get("sparse")
    return vector, None


@router.get("/points/{point_id}")
def point_detail(
    point_id: str,
    collection: str = Query(default=DEFAULT_COLLECTION),
    user: str = Depends(require_admin),
):
    """Full payload + dense & sparse vectors for a single point."""
    client = _client()
    recs = client.retrieve(
        collection_name=collection,
        ids=[point_id],
        with_payload=True,
        with_vectors=True,
    )
    if not recs:
        raise HTTPException(status_code=404, detail="Point not found")
    rec = recs[0]
    dense, sparse = _split_vectors(rec.vector)

    dense_info = None
    if dense is not None:
        dense_info = {
            "dim": len(dense),
            "norm": round(math.sqrt(sum(x * x for x in dense)), 4),
            "min": round(min(dense), 4),
            "max": round(max(dense), 4),
            "preview": [round(x, 4) for x in dense[:96]],
        }

    sparse_info = None
    if sparse is not None:
        indices = getattr(sparse, "indices", None)
        values = getattr(sparse, "values", None)
        if indices is None and isinstance(sparse, dict):
            indices, values = sparse.get("indices"), sparse.get("values")
        if indices is not None and values is not None:
            pairs = sorted(zip(indices, values), key=lambda t: t[1], reverse=True)
            sparse_info = {
                "nnz": len(indices),
                "top_terms": [{"index": int(i), "value": round(float(v), 4)} for i, v in pairs[:40]],
            }

    return {
        "point_id": str(rec.id),
        "payload": rec.payload or {},
        "dense": dense_info,
        "sparse": sparse_info,
    }


class SimilarRequest(BaseModel):
    point_id: str
    collection: str = DEFAULT_COLLECTION
    top_k: int = Field(default=10, ge=1, le=50)


@router.post("/similar")
def similar(body: SimilarRequest, user: str = Depends(require_admin)):
    """Nearest neighbours of a point by its dense vector."""
    client = _client()
    recs = client.retrieve(
        collection_name=body.collection, ids=[body.point_id], with_vectors=True
    )
    if not recs:
        raise HTTPException(status_code=404, detail="Point not found")
    dense, _ = _split_vectors(recs[0].vector)
    if dense is None:
        raise HTTPException(status_code=400, detail="Point has no dense vector")

    hits = _legacy_dense_search(body.collection, dense, body.top_k + 1)

    out = []
    for h in hits:
        if str(h["id"]) == body.point_id:
            continue
        p = h.get("payload") or {}
        out.append(
            {
                "point_id": str(h["id"]),
                "score": round(float(h["score"]), 4),
                "doc_id": p.get("doc_id"),
                "title": p.get("title"),
                "section": p.get("section"),
                "chunk_index": p.get("chunk_index"),
                "text": (p.get("text") or "")[:400],
            }
        )
    return {"results": out[: body.top_k]}


# ── Retrieval debugger ────────────────────────────────────────────────────


class SearchDebugRequest(BaseModel):
    query: str
    collection: str = DEFAULT_COLLECTION
    top_k: int = Field(default=10, ge=1, le=50)
    doc_id: Optional[str] = None


@router.post("/search-debug")
def search_debug(body: SearchDebugRequest, user: str = Depends(require_admin)):
    """Run the same query in dense, sparse and hybrid modes and compare."""
    searcher = _searcher_for(body.collection)
    out = {}
    for mode in ("dense", "sparse", "hybrid"):
        t0 = time.time()
        try:
            results = searcher.search(
                body.query, top_k=body.top_k, mode=mode, doc_id=body.doc_id or None
            )
        except Exception as e:  # noqa: BLE001
            out[mode] = {"error": str(e), "results": []}
            continue
        out[mode] = {
            "took_ms": round((time.time() - t0) * 1000, 1),
            "results": [
                {
                    "rank": i + 1,
                    "point_id": getattr(r, "chunk_id", None),
                    "chunk_id": r.chunk_id,
                    "doc_id": r.doc_id,
                    "title": r.title,
                    "section": r.section,
                    "chunk_index": r.chunk_index,
                    "score": round(float(r.score), 4),
                    "text": (r.text or "")[:300],
                }
                for i, r in enumerate(results)
            ],
        }
    return {"query": body.query, "modes": out}


# ── Vector-space projection (PCA → 2-D) ───────────────────────────────────


@router.get("/projection")
def projection(
    collection: str = Query(default=DEFAULT_COLLECTION),
    sample: int = Query(default=500, ge=50, le=_MAX_PROJECTION_SAMPLE),
    color_by: str = Query(default="journal"),
    user: str = Depends(require_admin),
):
    """2-D PCA projection of a sampled set of dense vectors for visualization."""
    import numpy as np

    client = _client()
    points, _ = client.scroll(
        collection_name=collection,
        limit=sample,
        with_payload=True,
        with_vectors=["dense"],
    )
    rows = []
    vecs = []
    for p in points:
        dense, _s = _split_vectors(p.vector)
        if not dense:
            continue
        vecs.append(dense)
        rows.append(p)
    if len(vecs) < 3:
        raise HTTPException(status_code=400, detail="Not enough vectors with dense data")

    X = np.asarray(vecs, dtype=np.float32)
    Xc = X - X.mean(axis=0, keepdims=True)
    # Truncated PCA via SVD; principal 2 components.
    _, S, Vt = np.linalg.svd(Xc, full_matrices=False)
    coords = Xc @ Vt[:2].T
    # Normalize to a [-1, 1] box for easy client rendering.
    span = np.abs(coords).max(axis=0)
    span[span == 0] = 1.0
    coords = coords / span

    var = (S ** 2)
    explained = (var[:2] / var.sum()).tolist() if var.sum() else [0.0, 0.0]

    out_points = []
    for (x, y), p in zip(coords.tolist(), rows):
        pl = p.payload or {}
        out_points.append(
            {
                "x": round(float(x), 4),
                "y": round(float(y), 4),
                "point_id": str(p.id),
                "doc_id": pl.get("doc_id"),
                "title": pl.get("title"),
                "section": pl.get("section"),
                "chunk_index": pl.get("chunk_index"),
                "color_key": str(pl.get(color_by) or pl.get("journal_id") or "—"),
            }
        )

    return {
        "collection": collection,
        "color_by": color_by,
        "count": len(out_points),
        "explained_variance": [round(e, 4) for e in explained],
        "points": out_points,
    }
