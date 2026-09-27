"""
Protocol & app-level tests for the MCP server.

All tests @pytest.mark.unit — no live Qdrant, no real embeddings.

Design note on MCP canonical URL:
  Starlette Mount("/mcp", sub_app) creates matching path /mcp/{path:path}.
  POST /mcp (no trailing slash) → 307 redirect → /mcp/ → handler.
  Tests send to /mcp/ directly. Path-nesting gotcha fix verified by
  checking POST /mcp/ succeeds (streamable_http_path="/", not default "/mcp").
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.unit

MCP_URL = "/mcp/"  # canonical URL (no redirect)


@dataclass
class FakeResult:
    chunk_id: str = "c1"
    doc_id: str = "2048-001-001-001"
    text: str = "نص تجريبي"
    title: str = "عنوان"
    section: str = "مقدمة"
    score: float = 0.9
    chunk_index: int = 0
    journal_id: str = "2048"
    char_len: int = 9
    raw_score: float = 0.9
    lexical_score: float = 0.6
    title_score: float = 0.0


def jsonrpc(method, params=None, id=1):
    p = {"jsonrpc": "2.0", "method": method, "id": id}
    if params is not None:
        p["params"] = params
    return p


def init_payload():
    return jsonrpc("initialize", {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "test", "version": "0"},
    })


@pytest.fixture()
def mcp_headers():
    return {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}


def fresh_client():
    """Create a fresh (module-reloaded) TestClient as context manager."""
    import importlib, backend.mcp_server, backend.main
    importlib.reload(backend.mcp_server)
    importlib.reload(backend.main)
    return TestClient(backend.main.app, raise_server_exceptions=False)


# ════════════════════════════════════════════════════════════════════════
# Protocol tests (share one client fixture)
# ════════════════════════════════════════════════════════════════════════

@pytest.fixture(scope="module")
def test_client():
    import importlib, backend.mcp_server, backend.main
    importlib.reload(backend.mcp_server)
    importlib.reload(backend.main)
    with TestClient(backend.main.app, raise_server_exceptions=False) as c:
        yield c


class TestMCPProtocol:
    def test_initialize_post_mcp(self, test_client, mcp_headers):
        """POST /mcp succeeds (307 redirect to /mcp/ then 200)."""
        resp = test_client.post("/mcp", json=init_payload(), headers=mcp_headers)
        assert resp.status_code == 200, f"Got {resp.status_code}: {resp.text[:200]}"
        assert "result" in resp.json()

    def test_canonical_mcp_slash(self, test_client, mcp_headers):
        """POST /mcp/ (canonical) succeeds directly — confirms path-nesting fix.

        streamable_http_path='/' makes the sub-app route at '/', so mounting
        at /mcp yields /mcp/ as the working endpoint (not /mcp/mcp).
        """
        resp = test_client.post(MCP_URL, json=init_payload(), headers=mcp_headers)
        assert resp.status_code == 200, f"Got {resp.status_code}: {resp.text[:200]}"
        assert "result" in resp.json()

    def test_tools_list_4_tools(self, test_client, mcp_headers):
        """tools/list: exactly 4 tools, each description mentions Arabic/Mandumah."""
        resp = test_client.post(MCP_URL, json=jsonrpc("tools/list"), headers=mcp_headers)
        assert resp.status_code == 200
        tools = resp.json().get("result", {}).get("tools", [])
        assert len(tools) == 4, f"Expected 4, got {len(tools)}"
        assert {t["name"] for t in tools} == {
            "search_articles", "get_article", "get_article_passages", "get_corpus_overview"
        }
        for t in tools:
            desc = t.get("description", "")
            assert any(w in desc.lower() for w in ("arabic", "mandumah")), (
                f"{t['name']} description missing Arabic mention: {desc!r}"
            )

    def test_tool_call_returns_envelope(self, test_client, mcp_headers):
        """tools/call search_articles returns {query, results} envelope."""
        with patch("backend.mcp_server.get_searcher") as gs:
            gs.return_value = MagicMock(search=MagicMock(return_value=[FakeResult()]))
            resp = test_client.post(
                MCP_URL,
                json=jsonrpc("tools/call", {"name": "search_articles", "arguments": {"query": "test"}}),
                headers=mcp_headers,
            )
        assert resp.status_code == 200
        content = resp.json().get("result", {}).get("content", [])
        assert len(content) > 0
        envelope = json.loads(content[0]["text"])
        assert "query" in envelope and "results" in envelope

    def test_bad_doc_id_tool_error(self, test_client, mcp_headers):
        """Bad doc_id → isError:true at MCP level, not HTTP 500."""
        resp = test_client.post(
            MCP_URL,
            json=jsonrpc("tools/call", {"name": "get_article", "arguments": {"doc_id": "../../etc/passwd"}}),
            headers=mcp_headers,
        )
        assert resp.status_code == 200
        assert resp.json().get("result", {}).get("isError") is True

    def test_malformed_json_server_survives(self, test_client, mcp_headers):
        """Malformed JSON body: some error returned, server still up."""
        resp = test_client.post(MCP_URL, content=b"{{bad", headers=mcp_headers)
        assert resp.status_code in (200, 400, 422)
        resp2 = test_client.post(MCP_URL, json=init_payload(), headers=mcp_headers)
        assert resp2.status_code == 200

    def test_body_size_guard(self, test_client):
        """POST /mcp/ body > 1 MiB → 413."""
        n = 1 * 1024 * 1024 + 1
        resp = test_client.post(
            MCP_URL, content=b"x" * n,
            headers={"Content-Type": "application/json", "Content-Length": str(n)}
        )
        assert resp.status_code == 413


class TestMCPKillSwitch:
    def test_mcp_disabled_404(self, mcp_headers):
        """MCP_ENABLED=false: POST /mcp → 404, mcp_server never imported."""
        for k in list(sys.modules):
            if "mcp_server" in k:
                del sys.modules[k]
        with patch.dict(os.environ, {"MCP_ENABLED": "false"}):
            import importlib, backend.main
            importlib.reload(backend.main)
            assert "backend.mcp_server" not in sys.modules
            with TestClient(backend.main.app, raise_server_exceptions=False) as c:
                assert c.post("/mcp", json=init_payload(), headers=mcp_headers).status_code == 404
        # Restore
        with patch.dict(os.environ, {"MCP_ENABLED": "true"}):
            import importlib, backend.mcp_server, backend.main
            importlib.reload(backend.mcp_server)
            importlib.reload(backend.main)


class TestMCPAuth:
    def test_auth_matrix(self, mcp_headers):
        """API_KEY set: no header→401, wrong→401, correct→200."""
        import importlib, backend.mcp_server, backend.main
        importlib.reload(backend.mcp_server)
        with patch.dict(os.environ, {"API_KEY": "s3cr3t", "MCP_ENABLED": "true"}):
            importlib.reload(backend.main)
            with TestClient(backend.main.app, raise_server_exceptions=False) as c:
                r = c.post(MCP_URL, json=init_payload(), headers=mcp_headers)
                assert r.status_code == 401, f"No key: {r.status_code}"
                r = c.post(MCP_URL, json=init_payload(), headers={**mcp_headers, "X-API-Key": "bad"})
                assert r.status_code == 401, f"Bad key: {r.status_code}"
                r = c.post(MCP_URL, json=init_payload(), headers={**mcp_headers, "X-API-Key": "s3cr3t"})
                assert r.status_code == 200, f"Good key: {r.status_code}: {r.text[:300]}"
        with patch.dict(os.environ, {"API_KEY": "", "MCP_ENABLED": "true"}):
            importlib.reload(backend.mcp_server)
            importlib.reload(backend.main)


class TestMCPRateLimit:
    def test_rate_limit_4th_call_429(self, mcp_headers):
        """Per-IP budget=3: calls 1-3 succeed, call 4 → 429 + Retry-After."""
        import importlib, backend.mcp_server, backend.main
        importlib.reload(backend.mcp_server)
        with patch.dict(os.environ, {"RATE_LIMIT_PER_MINUTE": "3", "MCP_ENABLED": "true"}):
            importlib.reload(backend.main)
            with TestClient(backend.main.app, raise_server_exceptions=False) as c:
                for i in range(3):
                    r = c.post(MCP_URL, json=init_payload(), headers=mcp_headers)
                    assert r.status_code != 429, f"Request {i+1} unexpectedly rate-limited"
                r = c.post(MCP_URL, json=init_payload(), headers=mcp_headers)
                assert r.status_code == 429, f"4th: expected 429, got {r.status_code}"
                assert "Retry-After" in r.headers
        with patch.dict(os.environ, {"MCP_ENABLED": "true"}):
            importlib.reload(backend.mcp_server)
            importlib.reload(backend.main)


# ════════════════════════════════════════════════════════════════════════
# Regression tests — existing routes unaffected by MCP mount
# ════════════════════════════════════════════════════════════════════════

class TestRegressionExistingEndpoints:
    @pytest.fixture(autouse=True)
    def _client(self):
        import importlib, backend.mcp_server, backend.main
        importlib.reload(backend.mcp_server)
        importlib.reload(backend.main)
        with TestClient(backend.main.app, raise_server_exceptions=False) as c:
            self._c = c
            yield

    def test_health_endpoint(self):
        with patch("backend.services.runtime.get_searcher") as gs:
            gs.return_value = MagicMock(
                collection_name="t",
                client=MagicMock(get_collection=MagicMock(return_value=MagicMock(points_count=1)))
            )
            assert self._c.get("/api/health").status_code == 200

    def test_search_endpoint(self):
        with patch("backend.main.get_searcher") as gs:
            gs.return_value = MagicMock(search=MagicMock(return_value=[FakeResult()]))
            resp = self._c.post("/api/search", json={"query": "تجربة", "top_k": 5})
        assert resp.status_code == 200
        assert "results" in resp.json()

    def test_stats_endpoint(self):
        with patch("backend.main.get_corpus_stats", return_value={"chunks": 5, "documents": 2}):
            resp = self._c.get("/api/stats")
        assert resp.status_code == 200
        assert "chunks" in resp.json()
