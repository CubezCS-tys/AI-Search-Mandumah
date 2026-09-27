"""
Integration tests — live retrieval.

Marked @pytest.mark.integration — requires:
  - Live Qdrant at QDRANT_URL with the academic_articles collection
  - A valid OPENAI_API_KEY (for embedding calls only)

Tests are automatically skipped when the environment is missing.
~10 embedding calls total (< $0.01).
"""

from __future__ import annotations

import json
import os
import re

import pytest

# ── Skip condition ─────────────────────────────────────────────────────────

_QDRANT_URL = os.getenv("QDRANT_URL", "")
_OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
_SKIP_REASON = (
    "Integration tests require QDRANT_URL and OPENAI_API_KEY environment variables"
)

skip_integration = pytest.mark.skipif(
    not (_QDRANT_URL and _OPENAI_API_KEY),
    reason=_SKIP_REASON,
)

pytestmark = [pytest.mark.integration, skip_integration]

_DOC_ID_PATTERN = re.compile(r"^\d{4}-\d{3}-\d{3}-\d{3}$")


# ── Fixtures ───────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def searcher():
    from backend.services.runtime import get_searcher
    return get_searcher()


# ── Tests ──────────────────────────────────────────────────────────────────

class TestLiveRetrieval:
    @pytest.mark.asyncio
    async def test_arabic_query_returns_results(self):
        """Arabic query returns ≥1 result with valid doc_id, Arabic snippet, score in [0,1]."""
        from backend import mcp_server
        result = await mcp_server.search_articles(query="التعلم الإلكتروني", top_k=5)
        assert result["total"] >= 1
        r = result["results"][0]
        assert _DOC_ID_PATTERN.match(r["doc_id"]), f"Invalid doc_id: {r['doc_id']}"
        assert r["snippet"], "Snippet is empty"
        assert 0.0 <= r["score"] <= 1.0

    @pytest.mark.asyncio
    async def test_search_parity_with_api(self):
        """search_articles and /api/search return the same ordered doc_ids."""
        from fastapi.testclient import TestClient
        from backend.main import app
        from backend import mcp_server

        query = "التعلم الإلكتروني"

        # MCP path
        mcp_result = await mcp_server.search_articles(query=query, top_k=10)
        mcp_doc_ids = [r["doc_id"] for r in mcp_result["results"]]

        # REST path
        client = TestClient(app)
        resp = client.post(
            "/api/search",
            json={"query": query, "top_k": 10, "deduplicate": True, "mode": "hybrid"},
        )
        assert resp.status_code == 200
        api_doc_ids = [r["doc_id"] for r in resp.json()["results"]]

        assert mcp_doc_ids == api_doc_ids, (
            f"MCP and API doc_id order differs:\nMCP: {mcp_doc_ids}\nAPI: {api_doc_ids}"
        )

    @pytest.mark.asyncio
    async def test_journal_id_filter(self):
        """All returned results carry the filtered journal_id."""
        from backend import mcp_server
        result = await mcp_server.search_articles(
            query="التعلم", top_k=5, journal_id="2048"
        )
        for r in result["results"]:
            assert r["journal_id"] == "2048", f"Expected journal_id 2048, got {r['journal_id']}"

    @pytest.mark.asyncio
    async def test_get_article_round_trip(self):
        """take doc_id from search → fetch text → total_chars matches content length."""
        from backend import mcp_server

        # Get a doc_id from search
        search_result = await mcp_server.search_articles(query="التعلم الإلكتروني", top_k=1)
        assert search_result["total"] >= 1
        doc_id = search_result["results"][0]["doc_id"]

        # Fetch the article
        article = await mcp_server.get_article(doc_id=doc_id, max_chars=40000)
        assert article["doc_id"] == doc_id
        assert article["total_chars"] > 0
        # The slice should match the beginning of content
        if not article["truncated"]:
            assert len(article["text"]) == article["total_chars"]

    @pytest.mark.asyncio
    async def test_get_article_passages_scoped_to_doc(self):
        """get_article_passages returns only chunks from the requested doc."""
        from backend import mcp_server

        # Get a doc_id from search
        search_result = await mcp_server.search_articles(query="التعلم", top_k=1)
        assert search_result["total"] >= 1
        doc_id = search_result["results"][0]["doc_id"]

        passages = await mcp_server.get_article_passages(
            doc_id=doc_id, query="التعلم", top_k=5
        )
        for r in passages["results"]:
            assert r["doc_id"] == doc_id, f"Expected doc_id {doc_id}, got {r['doc_id']}"

    @pytest.mark.asyncio
    async def test_low_confidence_on_garbage_query(self):
        """Nonsense query → low_confidence: true."""
        from backend import mcp_server
        result = await mcp_server.search_articles(query="xqzwv kjhgf nmlpq")
        assert result["low_confidence"] is True

    @pytest.mark.asyncio
    async def test_english_query_no_crash(self):
        """English query executes without error (may be low confidence)."""
        from backend import mcp_server
        result = await mcp_server.search_articles(query="electronic learning")
        # Just no crash
        assert "results" in result

    @pytest.mark.asyncio
    async def test_corpus_overview_matches_api_stats(self):
        """get_corpus_overview numbers match /api/stats exactly."""
        from fastapi.testclient import TestClient
        from backend.main import app
        from backend import mcp_server

        overview = await mcp_server.get_corpus_overview()

        client = TestClient(app)
        resp = client.get("/api/stats")
        assert resp.status_code == 200
        stats = resp.json()

        assert overview["documents"] == stats["documents"]
        assert overview["chunks"] == stats["chunks"]
