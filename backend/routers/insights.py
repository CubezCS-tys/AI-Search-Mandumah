"""Public read-only insight endpoints (/api/insights/*).

Thin un-authenticated wrappers over the SAME Qdrant PCA / kNN the admin console
uses. Zero OpenAI cost (local reads only). Security posture (PLAN-CORRECTIONS-v2
B3):
- collection is PINNED to the default; no public collection input (so the public
  cannot probe other collections on the box),
- caps are tighter than the admin equivalents,
- color_by is allow-listed (prevents arbitrary payload-key probing in PCA colour),
- rate limiting is applied centrally in main.py (the /api/insights prefix is in
  _RATE_LIMITED_PREFIXES, throttled on GET and POST).
The admin routes keep require_admin; we only add a separate public surface. Only
projection + similar are exposed; /overview is intentionally NOT public (its full
Qdrant scroll is a DoS footgun).
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from backend.routers.admin import (
    projection as _admin_projection,
    similar as _admin_similar,
    SimilarRequest,
    DEFAULT_COLLECTION,
)

router = APIRouter(prefix="/api/insights", tags=["insights"])

# Pin the public surface to the default corpus; never honour a client-supplied
# collection name.
_PUBLIC_COLLECTION = DEFAULT_COLLECTION
_ALLOWED_COLOR_BY = {"journal", "journal_id", "section", "year"}
_MAX_PUBLIC_SAMPLE = 800
_MAX_PUBLIC_TOP_K = 20


@router.get("/projection")
def public_projection(
    sample: int = Query(default=500, ge=50, le=_MAX_PUBLIC_SAMPLE),
    color_by: str = Query(default="journal", max_length=32),
):
    """Public 2-D PCA scatter of the pinned corpus (delegates to admin impl)."""
    if color_by not in _ALLOWED_COLOR_BY:
        raise HTTPException(status_code=422, detail="Unsupported color_by")
    # Direct call bypasses the admin handler's Depends(require_admin) (which only
    # runs on routed requests), with the collection pinned server-side.
    return _admin_projection(
        collection=_PUBLIC_COLLECTION,
        sample=sample,
        color_by=color_by,
        user="public",
    )


class PublicSimilarRequest(BaseModel):
    point_id: str = Field(..., max_length=128)
    top_k: int = Field(default=8, ge=1, le=_MAX_PUBLIC_TOP_K)


@router.post("/similar")
def public_similar(body: PublicSimilarRequest):
    """Public nearest-neighbour chunks for a point ("more like this")."""
    return _admin_similar(
        SimilarRequest(
            point_id=body.point_id,
            collection=_PUBLIC_COLLECTION,
            top_k=body.top_k,
        ),
        user="public",
    )
