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
    python -m services.search --query "أثر التعلم الإلكتروني" --top-k 5
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import re
import time
from dataclasses import dataclass, replace
from typing import Sequence

logger = logging.getLogger(__name__)

from backend.utils.arabic import (
    ARABIC_NORMALIZE_TABLE as _ARABIC_NORMALIZE_TABLE,
    ARABIC_DIACRITICS_RE as _ARABIC_DIACRITICS_RE,
    TOKEN_RE as _TOKEN_RE,
    STOPWORDS as _STOPWORDS_SET,
)
_AUTHORISH_TITLE_RE = re.compile(
    r"(^|\s)(?:أ\s*\.?\s*د|د\s*\.?|أ\s*\.?\s*م|م\s*\.?\s*م|الدكتور|الدكتوره|الدكتوراه|"
    r"الأستاذ|الاستاذ|الأستاذه|الاستاذه|prof\.?|dr\.?|by|اعداد|إعداد|بقلم)(\s|$)|"
    r"جامعة\s.+كلية|كلية\s.+قسم|قسم\s.+كلية|@|\.edu\.|\.ac\.|\.org$|\.com$",
    re.IGNORECASE,
)
_STOPWORDS = _STOPWORDS_SET


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
    raw_score: float = 0.0
    lexical_score: float = 0.0
    title_score: float = 0.0
    # MARC bibliographic fields (only populated for docs ingested with --marc-db;
    # null on a corpus without the sidecar). authors/keywords are JSON lists.
    authors: list[str] | None = None
    year: str | None = None
    journal: str | None = None
    keywords: list[str] | None = None


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
        self._qdrant_url = qdrant_url.rstrip("/")
        self.collection_name = collection_name
        self._embedder = embedder

    @property
    def embedder(self):
        if self._embedder is None:
            from backend.pipeline.embedder import OpenAIEmbedder
            self._embedder = OpenAIEmbedder()
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
        results = [self._point_to_result(p) for p in points]
        reranked = self._rerank_results(query, results)
        return self._filter_low_confidence_candidates(reranked)

    # NOTE: The Query API (query_points / server-side RRF fusion) requires
    # Qdrant >= 1.10/1.12. Production runs Qdrant 1.7.4, so dense and sparse
    # go through the legacy /points/search REST endpoint and hybrid fuses the
    # two result lists with RRF client-side.

    def _legacy_search(self, named_vector: dict, top_k: int, query_filter):
        """Single-vector kNN via the legacy ``/points/search`` REST endpoint.

        Returns objects exposing ``.id``, ``.score`` and ``.payload`` (the same
        attributes :meth:`_point_to_result` reads).
        """
        import requests
        from types import SimpleNamespace

        body: dict = {"vector": named_vector, "limit": top_k, "with_payload": True}
        if query_filter is not None:
            body["filter"] = query_filter.model_dump(mode="json", exclude_none=True)
        resp = requests.post(
            f"{self._qdrant_url}/collections/{self.collection_name}/points/search",
            json=body,
            timeout=30,
        )
        resp.raise_for_status()
        return [
            SimpleNamespace(id=h["id"], score=h["score"], payload=h.get("payload") or {})
            for h in resp.json().get("result", [])
        ]

    @staticmethod
    def _rrf_fuse(result_lists, top_k, k: int = 60):
        """Reciprocal Rank Fusion over several ranked result lists (client-side)."""
        scores: dict = {}
        points: dict = {}
        for results in result_lists:
            for rank, h in enumerate(results, start=1):
                scores[h.id] = scores.get(h.id, 0.0) + 1.0 / (k + rank)
                points[h.id] = h
        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:top_k]
        fused = []
        for pid, sc in ranked:
            p = points[pid]
            p.score = sc  # replace per-vector score with the fused RRF score
            fused.append(p)
        return fused

    def _dense_vector(self, emb) -> dict:
        return {"name": "dense", "vector": [float(x) for x in emb.dense]}

    def _sparse_vector(self, emb) -> dict:
        return {
            "name": "sparse",
            "vector": {
                "indices": [int(i) for i in emb.sparse_indices],
                "values": [float(v) for v in emb.sparse_values],
            },
        }

    def _hybrid_search(self, emb, top_k, prefetch_k, query_filter):
        """Dense + sparse with RRF fusion (client-side; Qdrant 1.7.4 compatible)."""
        dense = self._legacy_search(self._dense_vector(emb), prefetch_k, query_filter)
        sparse = self._legacy_search(self._sparse_vector(emb), prefetch_k, query_filter)
        return self._rrf_fuse([dense, sparse], top_k)

    def _dense_search(self, emb, top_k, query_filter):
        """Dense vector search only."""
        return self._legacy_search(self._dense_vector(emb), top_k, query_filter)

    def _sparse_search(self, emb, top_k, query_filter):
        """Sparse vector search only."""
        return self._legacy_search(self._sparse_vector(emb), top_k, query_filter)

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

    def search_with_hyde(
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
        """Search using Hypothetical Document Embeddings (HyDE).

        Generates a short hypothetical academic paragraph for the query,
        embeds that instead of the raw query, then runs normal search.
        Falls back to plain search on any generation error.
        """
        from backend.services.hyde import generate_hypothesis

        hypothesis = generate_hypothesis(query)
        return self.search(
            hypothesis,
            top_k=top_k,
            mode=mode,
            journal_id=journal_id,
            section=section,
            doc_id=doc_id,
            prefetch_limit=prefetch_limit,
        )

    def get_chunks_by_ids(self, chunk_ids: Sequence[str]) -> list[SearchResult]:
        """Fetch canonical chunks by their chunk IDs from Qdrant."""
        if not chunk_ids:
            return []

        point_ids = [hashlib.md5(chunk_id.encode()).hexdigest() for chunk_id in chunk_ids]
        points = self.client.retrieve(
            collection_name=self.collection_name,
            ids=point_ids,
            with_payload=True,
        )
        by_id = {str(point.id): point for point in points}
        ordered = [by_id[pid] for pid in point_ids if pid in by_id]
        return [self._point_to_result(p) for p in ordered]

    def _rerank_results(
        self,
        query: str,
        results: Sequence[SearchResult],
    ) -> list[SearchResult]:
        if not results:
            return []

        query_tokens = self._tokenize(query)
        query_token_set = set(query_tokens)
        query_bigrams = self._bigrams(query_tokens)
        query_norm = self._normalize_text(query)
        raw_scores = [r.raw_score for r in results]
        raw_min = min(raw_scores)
        raw_max = max(raw_scores)
        total = len(results)

        reranked: list[SearchResult] = []
        for rank, result in enumerate(results):
            title_token_list = self._tokenize(result.title)
            section_token_list = self._tokenize(result.section)
            body_token_list = self._tokenize(result.text[:1800])
            title_tokens = set(title_token_list)
            section_tokens = set(section_token_list)
            body_tokens = set(body_token_list)
            text_bigrams = self._bigrams(title_token_list[:24] + body_token_list[:48])

            title_coverage = self._coverage(query_token_set, title_tokens)
            body_coverage = self._coverage(query_token_set, body_tokens)
            section_coverage = self._coverage(query_token_set, section_tokens)
            bigram_coverage = self._coverage(query_bigrams, text_bigrams)
            source_norm = self._normalize_text(f"{result.title} {result.section} {result.text[:1800]}")

            phrase_bonus = 0.12 if query_norm and query_norm in source_norm else 0.0
            title_phrase_bonus = 0.08 if query_norm and query_norm in self._normalize_text(result.title) else 0.0
            lexical = min(
                1.0,
                (0.55 * title_coverage)
                + (0.25 * body_coverage)
                + (0.10 * section_coverage)
                + (0.10 * bigram_coverage)
                + phrase_bonus
                + title_phrase_bonus,
            )

            raw_norm = self._normalize_score(result.raw_score, raw_min, raw_max)
            rank_prior = 1.0 - (rank / max(total - 1, 1)) if total > 1 else 1.0
            suspicious_penalty = 0.14 if self._looks_like_authorish_title(result.title) else 0.0

            if lexical < 0.08 and title_coverage == 0.0 and body_coverage < 0.08:
                raw_norm *= 0.72
                rank_prior *= 0.72

            final_score = max(
                0.0,
                min(
                    1.0,
                    (0.45 * raw_norm)
                    + (0.25 * rank_prior)
                    + (0.30 * lexical)
                    - suspicious_penalty,
                ),
            )
            reranked.append(
                replace(
                    result,
                    score=round(final_score, 4),
                    lexical_score=round(lexical, 4),
                    title_score=round(title_coverage, 4),
                )
            )

        reranked.sort(key=lambda item: item.score, reverse=True)
        return reranked

    def _filter_low_confidence_candidates(
        self,
        results: Sequence[SearchResult],
    ) -> list[SearchResult]:
        if not results:
            return []

        best_score = results[0].score
        keep_floor = max(0.2, best_score * 0.42)
        kept: list[SearchResult] = []
        for idx, result in enumerate(results):
            anchor = max(result.lexical_score, result.title_score)
            if idx == 0 or result.score >= keep_floor or anchor >= 0.24:
                kept.append(result)

        if not kept:
            return list(results[:1])

        return kept

    @staticmethod
    def _normalize_text(text: str) -> str:
        normalized = _ARABIC_DIACRITICS_RE.sub("", (text or "").translate(_ARABIC_NORMALIZE_TABLE))
        normalized = normalized.lower()
        return " ".join(_TOKEN_RE.findall(normalized))

    @classmethod
    def _tokenize(cls, text: str) -> list[str]:
        return [
            token
            for token in cls._normalize_text(text).split()
            if len(token) > 1 and token not in _STOPWORDS
        ]

    @staticmethod
    def _bigrams(tokens: Sequence[str]) -> set[str]:
        return {" ".join(tokens[i : i + 2]) for i in range(len(tokens) - 1)}

    @staticmethod
    def _coverage(query_terms: set[str], source_terms: set[str]) -> float:
        if not query_terms or not source_terms:
            return 0.0
        return len(query_terms & source_terms) / len(query_terms)

    @staticmethod
    def _normalize_score(value: float, min_value: float, max_value: float) -> float:
        if max_value <= min_value:
            return 1.0
        return (value - min_value) / (max_value - min_value)

    @staticmethod
    def _looks_like_authorish_title(title: str) -> bool:
        stripped = (title or "").strip()
        if not stripped:
            return False
        return bool(_AUTHORISH_TITLE_RE.search(stripped))

    def _point_to_result(self, point) -> SearchResult:
        """Convert a Qdrant point to a SearchResult."""
        p = point.payload or {}
        raw_score = point.score if point.score is not None else 0.0
        return SearchResult(
            chunk_id=p.get("chunk_id", ""),
            doc_id=p.get("doc_id", ""),
            text=p.get("text", ""),
            title=p.get("title", ""),
            section=p.get("section", ""),
            score=raw_score,
            chunk_index=p.get("chunk_index", 0),
            journal_id=p.get("journal_id", ""),
            char_len=p.get("char_len", 0),
            raw_score=raw_score,
            authors=p.get("authors") or None,
            year=(str(p["year"]) if p.get("year") not in (None, "") else None),
            journal=p.get("journal") or None,
            keywords=p.get("keywords") or None,
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
