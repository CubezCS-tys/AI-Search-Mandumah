"""
Hybrid search module for Arabic academic documents.

Queries Qdrant using dense + sparse vectors from BGE-M3 with
Reciprocal Rank Fusion (RRF) to combine results.

Supports:
    - Hybrid search (dense + sparse, fused with RRF)
    - Dense-only or sparse-only modes
    - Metadata filters (journal, section, doc_id)
    - CLI for quick testing

Usage:
    python -m pipeline.search --query "أثر التعلم الإلكتروني" --top-k 5
"""

from __future__ import annotations

import argparse
import logging
import time
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class SearchResult:
    """A single search result."""
    chunk_id: str
    doc_id: str
    text: str
    title: str
    section: str
    score: float
    chunk_index: int
    journal_id: str
    char_len: int


class Searcher:
    """
    Hybrid search over Qdrant using BGE-M3 dense + sparse vectors.

    Usage:
        searcher = Searcher()
        results = searcher.search("أثر التعلم الإلكتروني", top_k=10)
        for r in results:
            print(f"{r.score:.3f} [{r.doc_id}] {r.text[:100]}")
    """

    def __init__(
        self,
        qdrant_url: str = "http://localhost:6333",
        collection_name: str = "academic_articles",
        embedder=None,
    ):
        from qdrant_client import QdrantClient

        self.client = QdrantClient(url=qdrant_url, timeout=30)
        self.collection_name = collection_name
        self._embedder = embedder

    @property
    def embedder(self):
        if self._embedder is None:
            from pipeline.embedder import BGEm3Embedder
            self._embedder = BGEm3Embedder()
        return self._embedder

    def search(
        self,
        query: str,
        *,
        top_k: int = 10,
        mode: str = "hybrid",
        journal_id: str | None = None,
        section: str | None = None,
        doc_id: str | None = None,
        prefetch_limit: int | None = None,
    ) -> list[SearchResult]:
        """
        Search for relevant chunks.

        Args:
            query: The search query text.
            top_k: Number of results to return.
            mode: Search mode — "hybrid", "dense", or "sparse".
            journal_id: Filter by journal ID.
            section: Filter by section name.
            doc_id: Filter by document ID (search within a document).
            prefetch_limit: Override prefetch size (default: top_k * 3).

        Returns:
            List of SearchResult sorted by relevance.
        """
        from qdrant_client import models

        # Embed the query
        t0 = time.time()
        emb = self.embedder.encode([query])[0]
        embed_ms = (time.time() - t0) * 1000
        logger.debug("Query embedded in %.0fms", embed_ms)

        # Build filter
        filter_conditions = self._build_filter(
            journal_id=journal_id, section=section, doc_id=doc_id
        )

        # Search
        t0 = time.time()
        prefetch_k = prefetch_limit or top_k * 3

        if mode == "hybrid":
            points = self._hybrid_search(emb, top_k, prefetch_k, filter_conditions)
        elif mode == "dense":
            points = self._dense_search(emb, top_k, filter_conditions)
        elif mode == "sparse":
            points = self._sparse_search(emb, top_k, filter_conditions)
        else:
            raise ValueError(f"Unknown search mode: {mode}")

        search_ms = (time.time() - t0) * 1000
        logger.debug("Search returned %d results in %.0fms (mode=%s)", len(points), search_ms, mode)

        return [self._point_to_result(p) for p in points]

    def _hybrid_search(self, emb, top_k, prefetch_k, query_filter):
        """Dense + sparse with RRF fusion."""
        from qdrant_client import models

        return self.client.query_points(
            collection_name=self.collection_name,
            prefetch=[
                models.Prefetch(
                    query=emb.dense,
                    using="dense",
                    limit=prefetch_k,
                    filter=query_filter,
                ),
                models.Prefetch(
                    query=models.SparseVector(
                        indices=emb.sparse_indices,
                        values=emb.sparse_values,
                    ),
                    using="sparse",
                    limit=prefetch_k,
                    filter=query_filter,
                ),
            ],
            query=models.FusionQuery(fusion=models.Fusion.RRF),
            limit=top_k,
            with_payload=True,
        ).points

    def _dense_search(self, emb, top_k, query_filter):
        """Dense vector search only."""
        from qdrant_client import models

        return self.client.query_points(
            collection_name=self.collection_name,
            query=emb.dense,
            using="dense",
            limit=top_k,
            with_payload=True,
            query_filter=query_filter,
        ).points

    def _sparse_search(self, emb, top_k, query_filter):
        """Sparse vector search only."""
        from qdrant_client import models

        return self.client.query_points(
            collection_name=self.collection_name,
            query=models.SparseVector(
                indices=emb.sparse_indices,
                values=emb.sparse_values,
            ),
            using="sparse",
            limit=top_k,
            with_payload=True,
            query_filter=query_filter,
        ).points

    def _build_filter(
        self,
        journal_id: str | None = None,
        section: str | None = None,
        doc_id: str | None = None,
    ):
        """Build Qdrant filter from metadata parameters."""
        from qdrant_client import models

        conditions = []
        if journal_id:
            conditions.append(
                models.FieldCondition(
                    key="journal_id",
                    match=models.MatchValue(value=journal_id),
                )
            )
        if section:
            conditions.append(
                models.FieldCondition(
                    key="section",
                    match=models.MatchValue(value=section),
                )
            )
        if doc_id:
            conditions.append(
                models.FieldCondition(
                    key="doc_id",
                    match=models.MatchValue(value=doc_id),
                )
            )

        if not conditions:
            return None
        return models.Filter(must=conditions)

    def _point_to_result(self, point) -> SearchResult:
        """Convert a Qdrant point to a SearchResult."""
        p = point.payload or {}
        return SearchResult(
            chunk_id=p.get("chunk_id", ""),
            doc_id=p.get("doc_id", ""),
            text=p.get("text", ""),
            title=p.get("title", ""),
            section=p.get("section", ""),
            score=point.score if point.score is not None else 0.0,
            chunk_index=p.get("chunk_index", 0),
            journal_id=p.get("journal_id", ""),
            char_len=p.get("char_len", 0),
        )


def main():
    parser = argparse.ArgumentParser(description="Search the academic articles index")
    parser.add_argument("--query", "-q", required=True, help="Search query")
    parser.add_argument("--top-k", "-k", type=int, default=5, help="Number of results")
    parser.add_argument("--mode", choices=["hybrid", "dense", "sparse"], default="hybrid", help="Search mode")
    parser.add_argument("--journal", default=None, help="Filter by journal ID")
    parser.add_argument("--section", default=None, help="Filter by section")
    parser.add_argument("--doc-id", default=None, help="Filter by document ID")
    parser.add_argument("--qdrant-url", default="http://localhost:6333", help="Qdrant server URL")
    parser.add_argument("--collection", default="academic_articles", help="Qdrant collection name")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    searcher = Searcher(
        qdrant_url=args.qdrant_url,
        collection_name=args.collection,
    )

    print(f"Searching: \"{args.query}\" (mode={args.mode}, top_k={args.top_k})")
    print()

    t0 = time.time()
    results = searcher.search(
        args.query,
        top_k=args.top_k,
        mode=args.mode,
        journal_id=args.journal,
        section=args.section,
        doc_id=args.doc_id,
    )
    total_ms = (time.time() - t0) * 1000

    if not results:
        print("No results found.")
        return

    for i, r in enumerate(results, 1):
        print(f"── Result {i} ─ score: {r.score:.4f} ──")
        print(f"   Doc:     {r.doc_id} (chunk {r.chunk_index})")
        print(f"   Title:   {r.title[:80]}")
        if r.section:
            print(f"   Section: {r.section}")
        print(f"   Text:    {r.text[:200]}...")
        print()

    print(f"── {len(results)} results in {total_ms:.0f}ms ({args.mode} search) ──")


if __name__ == "__main__":
    main()
