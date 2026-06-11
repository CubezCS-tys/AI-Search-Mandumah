"""
Unit tests for MCP tool logic.

All tests are marked @pytest.mark.unit — no network, no Qdrant, no OpenAI.
Searcher and the doc store are mocked.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

pytestmark = pytest.mark.unit


# ── Minimal SearchResult stand-in ─────────────────────────────────────────

@dataclass
class FakeResult:
    chunk_id: str = "c1"
    doc_id: str = "2048-001-001-001"
    text: str = "هذا نص تجريبي"
    title: str = "عنوان تجريبي"
    section: str = "مقدمة"
    score: float = 0.8
    chunk_index: int = 0
    journal_id: str = "2048"
    char_len: int = 14
    raw_score: float = 0.8
    lexical_score: float = 0.5
    title_score: float = 0.0


def make_results(n: int, doc_prefix: str = "2048-001-001-00") -> list[FakeResult]:
    """Make n fake results each with a unique doc_id."""
    return [
        FakeResult(
            chunk_id=f"c{i}",
            doc_id=f"{doc_prefix}{i+1}",
            text=f"نص رقم {i}",
            score=0.9 - i * 0.05,
        )
        for i in range(n)
    ]


# ── Helpers to call tools in isolation ────────────────────────────────────

async def call_search_articles(mock_results, **kwargs):
    """Call search_articles with a mocked Searcher."""
    with patch("backend.mcp_server.get_searcher") as mock_gs:
        searcher = MagicMock()
        searcher.search.return_value = mock_results
        mock_gs.return_value = searcher

        from backend import mcp_server
        result = await mcp_server.search_articles(**kwargs)
        return result, searcher


async def call_get_article(tmp_path: Path, doc_id: str, content: str = "محتوى المستند", **kwargs):
    """Call get_article with a mocked filesystem and Qdrant title lookup."""
    doc_path = tmp_path / doc_id
    doc_path.mkdir(parents=True, exist_ok=True)
    json_file = doc_path / f"{doc_id}.json"
    json_file.write_text(json.dumps({"content": content}), encoding="utf-8")

    with (
        patch("backend.mcp_server.doc_dir", return_value=doc_path),
        patch("backend.mcp_server._get_title_for_doc", return_value="عنوان تجريبي"),
    ):
        from backend import mcp_server
        return await mcp_server.get_article(doc_id=doc_id, **kwargs)


async def call_get_article_passages(mock_results, doc_id: str = "2048-001-001-001", **kwargs):
    """Call get_article_passages with a mocked Searcher."""
    with patch("backend.mcp_server.get_searcher") as mock_gs:
        searcher = MagicMock()
        searcher.search.return_value = mock_results
        mock_gs.return_value = searcher

        from backend import mcp_server
        result = await mcp_server.get_article_passages(doc_id=doc_id, query="استعلام", **kwargs)
        return result, searcher


# ════════════════════════════════════════════════════════════════════════
# search_articles tests
# ════════════════════════════════════════════════════════════════════════

class TestSearchArticles:
    @pytest.mark.asyncio
    async def test_returns_response_envelope(self):
        """Returns {query, total, low_confidence, results} with all fields."""
        results, _ = await call_search_articles(
            make_results(3),
            query="التعلم الإلكتروني",
        )
        assert "query" in results
        assert "total" in results
        assert "low_confidence" in results
        assert "results" in results
        assert results["query"] == "التعلم الإلكتروني"
        assert results["total"] == 3

        r0 = results["results"][0]
        for field in ("doc_id", "title", "section", "journal_id", "score",
                      "snippet", "chunk_index", "pdf_url"):
            assert field in r0, f"Missing field: {field}"

    @pytest.mark.asyncio
    async def test_dedup_top_k(self):
        """Deduplicates to one chunk per doc_id and respects top_k after dedup.

        Feed 12 chunks across 4 docs (3 chunks per doc), ask top_k=3.
        Should return 3 docs, each represented once.
        """
        # 3 chunks per doc, 4 docs interleaved
        docs = ["2048-001-001-001", "2048-001-001-002", "2048-001-001-003", "2048-001-001-004"]
        raw = []
        for i in range(3):
            for doc in docs:
                raw.append(FakeResult(
                    chunk_id=f"{doc}-c{i}",
                    doc_id=doc,
                    text=f"chunk {i} of {doc}",
                    score=0.9 - i * 0.1,
                    chunk_index=i,
                ))

        results, _ = await call_search_articles(raw, query="استعلام", top_k=3)
        assert results["total"] == 3
        doc_ids = [r["doc_id"] for r in results["results"]]
        assert len(set(doc_ids)) == 3  # exactly 3 unique docs

    @pytest.mark.asyncio
    async def test_snippet_truncation_long(self):
        """Text > 700 chars is cut on a word boundary ending with '…'."""
        long_text = "كلمة " * 200  # well over 700 chars
        raw = [FakeResult(text=long_text, score=0.9)]
        results, _ = await call_search_articles(raw, query="استعلام")
        snippet = results["results"][0]["snippet"]
        assert snippet.endswith("…")
        assert len(snippet) <= 706  # 700 + len("…") with some word-boundary slack

    @pytest.mark.asyncio
    async def test_snippet_no_truncation_short(self):
        """Text ≤ 700 chars is returned verbatim without '…'."""
        short_text = "نص قصير"
        raw = [FakeResult(text=short_text, score=0.9)]
        results, _ = await call_search_articles(raw, query="استعلام")
        snippet = results["results"][0]["snippet"]
        assert snippet == short_text
        assert not snippet.endswith("…")

    @pytest.mark.asyncio
    async def test_top_k_clamp_low(self):
        """top_k=0 is treated as 1; no exception."""
        results, _ = await call_search_articles(make_results(5), query="استعلام", top_k=0)
        assert results["total"] == 1

    @pytest.mark.asyncio
    async def test_top_k_clamp_high(self):
        """top_k=999 is treated as 25; no exception."""
        results, _ = await call_search_articles(make_results(5), query="استعلام", top_k=999)
        assert results["total"] == 5  # only 5 mocked results

    @pytest.mark.asyncio
    async def test_empty_query_error(self):
        """Empty or whitespace-only query → ToolError, not a crash."""
        from mcp.server.fastmcp.exceptions import ToolError
        with pytest.raises(ToolError):
            await call_search_articles([], query="")
        with pytest.raises(ToolError):
            await call_search_articles([], query="   ")

    @pytest.mark.asyncio
    async def test_long_query_error(self):
        """Query longer than 2000 chars → ToolError."""
        from mcp.server.fastmcp.exceptions import ToolError
        with pytest.raises(ToolError):
            await call_search_articles([], query="x" * 2001)

    @pytest.mark.asyncio
    async def test_low_confidence_flag_weak(self):
        """low_confidence is True when top score < 0.34."""
        weak = [FakeResult(score=0.2, lexical_score=0.05)]
        results, _ = await call_search_articles(weak, query="استعلام")
        assert results["low_confidence"] is True

    @pytest.mark.asyncio
    async def test_low_confidence_flag_strong(self):
        """low_confidence is False on a strong result."""
        strong = [FakeResult(score=0.85, lexical_score=0.6)]
        results, _ = await call_search_articles(strong, query="استعلام")
        assert results["low_confidence"] is False

    @pytest.mark.asyncio
    async def test_filters_forwarded_to_searcher(self):
        """journal_id and section are forwarded to Searcher.search."""
        results, searcher = await call_search_articles(
            make_results(2),
            query="استعلام",
            journal_id="2048",
            section="مقدمة",
        )
        call_kwargs = searcher.search.call_args.kwargs
        assert call_kwargs.get("journal_id") == "2048"
        assert call_kwargs.get("section") == "مقدمة"

    @pytest.mark.asyncio
    async def test_pdf_url_uses_public_base_url(self, monkeypatch):
        """pdf_url uses the PUBLIC_BASE_URL env override."""
        monkeypatch.setenv("PUBLIC_BASE_URL", "https://example.com")
        # Reload to pick up the env change
        import importlib
        import backend.mcp_server
        importlib.reload(backend.mcp_server)

        raw = [FakeResult(doc_id="2048-001-001-001", score=0.9)]
        with patch("backend.mcp_server.get_searcher") as mock_gs:
            searcher = MagicMock()
            searcher.search.return_value = raw
            mock_gs.return_value = searcher
            result = await backend.mcp_server.search_articles(query="استعلام")

        pdf_url = result["results"][0]["pdf_url"]
        assert pdf_url.startswith("https://example.com")

        # Restore
        importlib.reload(backend.mcp_server)


# ════════════════════════════════════════════════════════════════════════
# get_article tests
# ════════════════════════════════════════════════════════════════════════

class TestGetArticle:
    @pytest.mark.asyncio
    async def test_valid_doc_returns_text(self, tmp_path):
        """Valid doc_id with existing JSON → returns text, total_chars, truncated."""
        content = "محتوى المستند التجريبي لاختبار الوحدة"
        result = await call_get_article(
            tmp_path, "2048-001-001-001", content=content
        )
        assert result["text"] == content
        assert result["total_chars"] == len(content)
        assert result["truncated"] is False

    @pytest.mark.asyncio
    async def test_paging_slice(self, tmp_path):
        """offset + max_chars slice correctly."""
        content = "أ" * 5000
        # Use max_chars=1500 (within valid range [1000, 40000])
        result = await call_get_article(
            tmp_path,
            "2048-001-001-001",
            content=content,
            offset=1000,
            max_chars=1500,
        )
        assert result["text"] == content[1000:2500]
        assert result["truncated"] is True
        assert result["offset"] == 1000

    @pytest.mark.asyncio
    async def test_paging_offset_past_end(self, tmp_path):
        """offset past end → empty text, truncated: false, no error."""
        content = "نص قصير"
        result = await call_get_article(
            tmp_path,
            "2048-001-001-001",
            content=content,
            offset=10000,
        )
        assert result["text"] == ""
        assert result["truncated"] is False

    @pytest.mark.asyncio
    async def test_max_chars_clamped(self, tmp_path):
        """max_chars is clamped to [1000, 40000]."""
        content = "أ" * 2000
        result_low = await call_get_article(
            tmp_path, "2048-001-001-001", content=content, max_chars=1
        )
        assert len(result_low["text"]) == 1000  # clamped to min

        result_high = await call_get_article(
            tmp_path, "2048-001-001-001", content=content, max_chars=99999
        )
        # Content is only 2000 chars so no truncation
        assert result_high["truncated"] is False

    # ── doc_id validation matrix ─────────────────────────────────────────

    @pytest.mark.asyncio
    @pytest.mark.parametrize("bad_id", [
        "../../etc/passwd",
        "/etc/passwd",
        "2048-014-003-024/../x",
        "2048_014_003_024",
        "20480-14-003-024",
        "",
        "x" * 10000,
        "2048-014-003-\x00024",  # null byte
    ])
    async def test_doc_id_validation_rejects(self, bad_id):
        """Each invalid doc_id is rejected with ToolError and NO filesystem call."""
        from mcp.server.fastmcp.exceptions import ToolError
        with (
            patch("backend.mcp_server.doc_dir") as mock_doc_dir,
            patch("backend.mcp_server.load_doc_content_cached") as mock_loader,
        ):
            with pytest.raises(ToolError):
                from backend import mcp_server
                await mcp_server.get_article(doc_id=bad_id)

            # Filesystem helpers must NOT have been called.
            mock_doc_dir.assert_not_called()
            mock_loader.assert_not_called()

    @pytest.mark.asyncio
    async def test_nonexistent_doc_id_not_found(self, tmp_path):
        """Well-formed but nonexistent doc_id → 'Article not found' ToolError."""
        from mcp.server.fastmcp.exceptions import ToolError

        empty_dir = tmp_path / "2048-999-999-999"
        empty_dir.mkdir()

        with patch("backend.mcp_server.doc_dir", return_value=empty_dir):
            with pytest.raises(ToolError, match="Article not found"):
                from backend import mcp_server
                await mcp_server.get_article(doc_id="2048-999-999-999")

    @pytest.mark.asyncio
    async def test_title_from_index(self, tmp_path):
        """Title lookup: present in index → title string."""
        content = "محتوى"
        doc_path = tmp_path / "2048-001-001-001"
        doc_path.mkdir()
        (doc_path / "2048-001-001-001.json").write_text(
            json.dumps({"content": content}), encoding="utf-8"
        )
        with (
            patch("backend.mcp_server.doc_dir", return_value=doc_path),
            patch("backend.mcp_server._get_title_for_doc", return_value="عنوان من الفهرس"),
        ):
            from backend import mcp_server
            result = await mcp_server.get_article(doc_id="2048-001-001-001")
        assert result["title"] == "عنوان من الفهرس"

    @pytest.mark.asyncio
    async def test_title_absent_from_index(self, tmp_path):
        """Title lookup: absent → title: null."""
        content = "محتوى"
        doc_path = tmp_path / "2048-001-001-001"
        doc_path.mkdir()
        (doc_path / "2048-001-001-001.json").write_text(
            json.dumps({"content": content}), encoding="utf-8"
        )
        with (
            patch("backend.mcp_server.doc_dir", return_value=doc_path),
            patch("backend.mcp_server._get_title_for_doc", return_value=None),
        ):
            from backend import mcp_server
            result = await mcp_server.get_article(doc_id="2048-001-001-001")
        assert result["title"] is None


# ════════════════════════════════════════════════════════════════════════
# get_article_passages tests
# ════════════════════════════════════════════════════════════════════════

class TestGetArticlePassages:
    @pytest.mark.asyncio
    async def test_forwards_doc_id_filter(self):
        """Forwards doc_id filter to Searcher.search (no dedup)."""
        raw = make_results(3, doc_prefix="2048-001-001-00")
        # All same doc_id to test no-dedup
        for r in raw:
            r.doc_id = "2048-001-001-001"

        result, searcher = await call_get_article_passages(raw, doc_id="2048-001-001-001")
        call_kwargs = searcher.search.call_args.kwargs
        assert call_kwargs.get("doc_id") == "2048-001-001-001"
        # No dedup → all 3 returned
        assert result["total"] == 3

    @pytest.mark.asyncio
    async def test_returns_full_text_not_snippet(self):
        """Returns full chunk text (not 700-char snippet)."""
        long_text = "ن " * 500  # 1000 chars
        raw = [FakeResult(text=long_text, score=0.9, doc_id="2048-001-001-001")]
        result, _ = await call_get_article_passages(raw, doc_id="2048-001-001-001")
        assert result["results"][0]["snippet"] == long_text
        assert not result["results"][0]["snippet"].endswith("…")

    @pytest.mark.asyncio
    @pytest.mark.parametrize("bad_id", [
        "../../etc/passwd",
        "/etc/passwd",
        "2048_014_003_024",
        "",
        "x" * 10000,
    ])
    async def test_doc_id_validation(self, bad_id):
        """Same doc_id validation as get_article."""
        from mcp.server.fastmcp.exceptions import ToolError
        with pytest.raises(ToolError):
            from backend import mcp_server
            await mcp_server.get_article_passages(doc_id=bad_id, query="استعلام")

    @pytest.mark.asyncio
    async def test_top_k_clamped(self):
        """top_k is clamped to [1, 10]."""
        raw = make_results(12)
        for r in raw:
            r.doc_id = "2048-001-001-001"

        with patch("backend.mcp_server.get_searcher") as mock_gs:
            searcher = MagicMock()
            searcher.search.return_value = raw
            mock_gs.return_value = searcher
            from backend import mcp_server
            await mcp_server.get_article_passages(
                doc_id="2048-001-001-001", query="استعلام", top_k=999
            )
            call_kwargs = searcher.search.call_args.kwargs
            assert call_kwargs.get("top_k") == 10  # clamped


# ════════════════════════════════════════════════════════════════════════
# get_corpus_overview tests
# ════════════════════════════════════════════════════════════════════════

class TestGetCorpusOverview:
    @pytest.mark.asyncio
    async def test_returns_required_fields(self):
        """Returns documents, chunks, collection, language, description."""
        with patch("backend.mcp_server.get_corpus_stats", return_value={"documents": 42, "chunks": 1000}):
            from backend import mcp_server
            result = await mcp_server.get_corpus_overview()
        for field in ("documents", "chunks", "collection", "language", "description"):
            assert field in result, f"Missing field: {field}"
        assert result["language"] == "ar"
        assert result["documents"] == 42
        assert result["chunks"] == 1000

    @pytest.mark.asyncio
    async def test_qdrant_failure_graceful(self):
        """Qdrant facet failure → graceful degraded response, not a crash."""
        with patch("backend.mcp_server.get_corpus_stats", return_value={"documents": 0, "chunks": 0, "error": "connection failed"}):
            from backend import mcp_server
            result = await mcp_server.get_corpus_overview()
        assert result["documents"] == 0
        assert "collection" in result


# ════════════════════════════════════════════════════════════════════════
# Shared-code guarantee tests
# ════════════════════════════════════════════════════════════════════════

class TestSharedCodeGuarantees:
    def test_dedup_function_identity(self):
        """The dedup helper in mcp_server and main are the same function object.

        Guards against copy-paste drift (plan Section 5.1).
        """
        import backend.mcp_server as ms
        import backend.main as main_mod
        assert ms.dedup_results is main_mod.dedup_results

    def test_no_forbidden_imports(self):
        """mcp_server must not import synthesis, chat, corpus_chat, or hyde."""
        import ast
        import inspect
        src_path = Path(inspect.getfile(__import__("backend.mcp_server", fromlist=["x"])))
        source = src_path.read_text(encoding="utf-8")
        tree = ast.parse(source)

        forbidden = {"synthesis", "chat", "corpus_chat", "hyde"}
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                if isinstance(node, ast.ImportFrom) and node.module:
                    for f in forbidden:
                        assert f not in node.module, (
                            f"mcp_server.py imports forbidden module containing '{f}'"
                        )
                elif isinstance(node, ast.Import):
                    for alias in node.names:
                        for f in forbidden:
                            assert f not in alias.name, (
                                f"mcp_server.py imports forbidden module containing '{f}'"
                            )
