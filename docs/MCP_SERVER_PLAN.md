# MCP Server Implementation Plan — Mandumah Retrieval over MCP

**Status:** Approved for implementation — hand-off document for the implementing agent.
**Branch:** `feature/mcp-server`
**Reviewer:** A separate review pass will check the finished work against the acceptance criteria at the bottom of this file and the test spec in `docs/MCP_SERVER_TESTING.md`.

---

## 1. Goal and context

Expose the existing Mandumah retrieval stack (Qdrant hybrid search + document store) as a
**remote MCP (Model Context Protocol) server** over Streamable HTTP, so that:

1. A **Microsoft Copilot Studio agent** can attach it as a tool and answer questions from
   Mandumah's corpus inside Copilot/Teams (shareholder demo).
2. The same server later serves as the artifact for a **Microsoft 365 federated Copilot
   connector** gallery submission, and works with any MCP-capable client (Claude, etc.).

**Critical design rule: the MCP server is retrieval-only.** It returns ranked passages and
article text. It must NOT call the answer-synthesis/chat LLM paths
(`backend/services/synthesis.py`, `backend/services/chat.py`, `backend/services/corpus_chat.py`).
Answer generation happens on the MCP client's side (Copilot's model). The only model call
permitted per request is the **query embedding** (OpenAI `text-embedding-3-small` via
`backend/pipeline/embedder.py:OpenAIEmbedder`). HyDE (`backend/services/hyde.py`) is an LLM
call and is therefore **excluded** from the MCP path.

## 2. What already exists (reuse, do not rebuild)

| Component | Location | Notes |
|---|---|---|
| FastAPI app | `backend/main.py` | Has CORS, `X-API-Key` guard middleware, body-size + per-IP rate limiting |
| Hybrid searcher | `backend/services/search.py:Searcher` | `search()` does embed → Qdrant hybrid (dense+sparse RRF) → lexical rerank → low-confidence filter. Returns `SearchResult` dataclasses |
| Searcher singleton | `backend/main.py:get_searcher()` | Lazy, thread-safe; reads `QDRANT_URL`, `COLLECTION_NAME` env vars |
| Doc locator | `backend/main.py:_doc_dir(doc_id)` | Resolves a doc ID to its directory in `output/output_XXXX/<doc_id>/` or flat `output_batch05/<doc_id>/` |
| Doc content loader | `backend/main.py:_load_doc_content_cached` | Reads `content` field from `<doc_id>.json` (Azure Document Intelligence OCR output), LRU-cached |
| Doc ID validation | `backend/main.py:_DOC_ID_RE` = `^\d{4}-\d{3}-\d{3}-\d{3}$` | MUST be applied to every doc_id accepted from an MCP client |
| Stats | `/api/stats` route logic | Qdrant facet count on `doc_id` for unique-document count |

Qdrant point payload fields available per chunk: `chunk_id`, `doc_id`, `text`, `title`,
`section`, `chunk_index`, `journal_id`, `char_len`. There is **no** author/year/abstract
metadata in the index — do not invent fields.

## 3. Deliverables

1. `backend/mcp_server.py` — new module: FastMCP server with 4 tools (Section 5).
2. Modification to `backend/main.py` — mount the MCP ASGI app at `/mcp` (Section 6).
3. `requirements.txt` — add the `mcp` Python SDK (Section 7).
4. `backend/tests/` — pytest suite per `docs/MCP_SERVER_TESTING.md`.
5. `docs/MCP_COPILOT_STUDIO_SETUP.md` — step-by-step guide (clicks, not code) for the
   tenant admin who will attach the server to a Copilot Studio agent (Section 9).
6. Updated `README.md` — short "MCP server" section: what it is, how to run, how to test.

## 4. Architecture

```
MCP client (Copilot Studio / Claude / MCP Inspector)
        │  Streamable HTTP (POST /mcp), JSON-RPC 2.0
        ▼
FastAPI app (backend/main.py)  ──existing middleware──► X-API-Key guard, body limit
        │  app.mount("/mcp", mcp_app)
        ▼
backend/mcp_server.py (FastMCP, stateless)
        │  tools: search_articles, get_article, get_article_passages, get_corpus_overview
        ▼
Searcher (backend/services/search.py) ──► OpenAI embedding (query only) ──► Qdrant
Doc store (output/, output_batch05/ JSON files)
```

Decisions, fixed (do not relitigate):

- **Same process as the existing API.** Mount into the existing FastAPI app rather than a
  second service. One deployment, shared `Searcher` singleton (the embedder and Qdrant
  client are already lazy singletons — reuse `get_searcher()`).
- **Transport: Streamable HTTP, stateless** (`stateless_http=True`). Microsoft's federated
  connectors and Copilot Studio require remote servers over Streamable HTTP; stateless mode
  avoids session-affinity problems behind any proxy.
- **Auth for phase 1: API key** via the existing `X-API-Key` middleware (the `/mcp` path is
  intentionally NOT exempt). Copilot Studio custom connectors support API-key header auth.
  OAuth 2.1 is required only for the eventual Microsoft gallery submission — that is
  **phase 2, out of scope** here; leave a `# phase 2: OAuth` note where auth is wired.
- **Tool names/descriptions in English; content is Arabic.** Tool descriptions must state
  that the corpus is Arabic academic literature and that Arabic queries retrieve best —
  Copilot's orchestrator reads these descriptions to decide when/how to call the tools.
- **No LLM calls inside tools** (embedding-only rule from Section 1). `deduplicate`
  behaviour (top chunk per document) is the default for `search_articles`, mirroring
  `/api/search`.

## 5. Tool specifications

Implement with `mcp.server.fastmcp.FastMCP` using typed Python signatures (FastMCP derives
JSON schemas from type hints + docstrings). All tools return JSON-serializable dicts.
All Qdrant/file I/O must run via `anyio.to_thread.run_sync` (or `asyncio.to_thread`) —
the `Searcher` is synchronous and must not block the event loop.

### 5.1 `search_articles`

```python
async def search_articles(
    query: str,                      # natural-language query; Arabic recommended
    top_k: int = 10,                 # 1..25, clamp out-of-range rather than error
    journal_id: str | None = None,   # optional 4-digit journal filter, e.g. "2048"
    section: str | None = None,      # optional section-name filter
) -> dict
```

- Validate: non-empty query after `.strip()`, max length 2000 (mirror `SearchRequest`).
- Call `searcher.search(query, top_k=min(top_k*5, 100), mode="hybrid", journal_id=..., section=...)`,
  then deduplicate to top chunk per `doc_id` and truncate to `top_k` — same logic as
  `/api/search` in `backend/main.py` (extract that dedup block into a small shared helper
  rather than copy-pasting; the route and the tool should call the same function).
- Compute the same `low_confidence` flag as `/api/search` (top score < 0.34 or mean
  lexical of top-3 < 0.14) and include it in the response so Copilot can hedge.
- Per result, return: `doc_id`, `title`, `section`, `journal_id`, `score`,
  `snippet` (chunk text truncated to **700 chars** on a word boundary, with `…`),
  `chunk_index`, and `pdf_url` (see Section 5.5).
- Response envelope: `{"query": ..., "total": N, "low_confidence": bool, "results": [...]}`.

Docstring (becomes the tool description — write it for Copilot's orchestrator):
search the Mandumah Arabic academic article corpus; returns ranked passages with metadata;
results are in Arabic; use `get_article` for the full text of a specific result.

### 5.2 `get_article`

```python
async def get_article(
    doc_id: str,                     # e.g. "2048-014-003-024"
    max_chars: int = 8000,           # 1000..40000, clamp
    offset: int = 0,                 # character offset for paging long articles
) -> dict
```

- Validate `doc_id` against `_DOC_ID_RE`; reject otherwise (this is the path-traversal
  guard — never interpolate an unvalidated doc_id into a filesystem path).
- Load full text via the existing cached loader (`<doc_id>.json` → `content`).
- Return `{"doc_id", "title", "journal_id", "total_chars", "offset", "text", "truncated": bool, "pdf_url"}`.
  `title` comes from a top-1 Qdrant lookup filtered by `doc_id` (payload `title`), since
  the OCR JSON has no title field; if the doc isn't in the index, return `title: null`.
- Not found → MCP tool error with message `"Article not found: <doc_id>"` (use FastMCP's
  error mechanism / raise `McpError` equivalent — do not return a 500).

### 5.3 `get_article_passages`

```python
async def get_article_passages(
    doc_id: str,
    query: str,                      # what to look for inside this article
    top_k: int = 5,                  # 1..10, clamp
) -> dict
```

- Same doc_id validation. Calls `searcher.search(query, top_k=top_k, mode="hybrid", doc_id=doc_id)`
  (no dedup — multiple chunks from the same doc is the point here).
- Returns the same per-result shape as `search_articles` but with full chunk `text`
  (not the 700-char snippet) since results are scoped to one article.
- Purpose: lets Copilot drill into a specific paper without pulling 60k chars via
  `get_article`. Say so in the docstring.

### 5.4 `get_corpus_overview`

```python
async def get_corpus_overview() -> dict
```

- Reuse the `/api/stats` logic (collection points count + `doc_id` facet count).
  Extract into a shared helper used by both the route and the tool.
- Return `{"documents": N, "chunks": N, "collection": name, "language": "ar", "description": short English description of the corpus}`.
- Purpose: demo-friendly ("how many articles do you cover?") and helps the orchestrator
  understand scope.

### 5.5 PDF / article links

- Add env var `PUBLIC_BASE_URL` (default `http://localhost:8000`). Build
  `pdf_url = f"{PUBLIC_BASE_URL}/api/pdf/{doc_id}"`.
- Rationale: Copilot renders citations as links; these must resolve from the user's
  browser, hence configurable public base.

## 6. Mounting into FastAPI — known gotchas

In `backend/mcp_server.py`:

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP(
    "mandumah-search",
    stateless_http=True,
    json_response=True,   # plain JSON responses; simplest for Copilot Studio
)
# @mcp.tool() decorated functions...
mcp_app = mcp.streamable_http_app()
```

In `backend/main.py`:

```python
from backend.mcp_server import mcp, mcp_app
app.mount("/mcp", mcp_app)
```

Gotchas the implementer MUST handle (verify against the installed SDK version's docs):

1. **Lifespan:** the streamable-HTTP session manager requires its lifespan to run. The
   existing app defines no lifespan, so add one that runs `mcp.session_manager.run()`
   (`contextlib.asynccontextmanager` wrapping `async with mcp.session_manager.run(): yield`)
   and pass it to the `FastAPI(...)` constructor. Without this, every MCP request 500s.
2. **Path nesting:** `streamable_http_app()` itself serves at a configurable internal path
   (default `/mcp`). Mounted at `/mcp`, the endpoint could become `/mcp/mcp`. Set the
   FastMCP `streamable_http_path="/"` so the final public endpoint is exactly **`/mcp`**.
   Confirm with a curl `initialize` call (test spec has the exact command).
3. **Middleware interaction:** the API-key and abuse-guard middlewares in `backend/main.py`
   run for mounted apps too. That is intended for auth. But add `/mcp` to
   `_RATE_LIMITED_PREFIXES` so MCP search calls share the per-IP rate budget, and confirm
   the body-size guard doesn't break JSON-RPC POSTs (it won't at 1 MiB, but the test spec
   covers it).
4. **Searcher reuse:** import `get_searcher` from `backend.main` would create a circular
   import. Move `get_searcher()` (and the small shared helpers from Sections 5.1/5.4) into
   a new `backend/services/runtime.py` (or similar) imported by both `main.py` and
   `mcp_server.py`. Keep behaviour identical (lazy, lock-guarded, same env vars).

## 7. Dependencies

- Add to `requirements.txt`: `mcp` — pin to the latest 1.x stable available at
  implementation time (check PyPI; it must include the FastMCP server with
  `streamable_http_app` and `stateless_http` support).
- Nothing else. Do not add a web framework, do not add LangChain, do not vendor SDKs.

## 8. Configuration summary (env vars)

| Var | Default | Used for |
|---|---|---|
| `QDRANT_URL` | `http://localhost:6333` | existing |
| `COLLECTION_NAME` | `academic_articles` | existing |
| `API_KEY` | unset | existing guard; when set, MCP clients must send `X-API-Key` |
| `PUBLIC_BASE_URL` | `http://localhost:8000` | building `pdf_url` in tool results |
| `MCP_ENABLED` | `true` | if `false`/`0`, skip mounting `/mcp` entirely (kill switch) |
| `OPENAI_API_KEY` | required | existing — query embeddings |

## 9. Copilot Studio setup guide (deliverable 5)

Write `docs/MCP_COPILOT_STUDIO_SETUP.md` for a non-developer tenant admin. It must cover:
prerequisites (M365 tenant, Copilot Studio access, the deployed server URL + API key);
creating an agent; adding a custom MCP server connection (URL = `https://<host>/mcp`,
auth = API key header `X-API-Key`); writing agent instructions (provide ready-to-paste
text: answer from Mandumah tools only, cite `pdf_url` links, answer in the user's
language, prefer Arabic search queries); publishing to a demo website / Teams; and the
five rehearsed demo questions (leave placeholders — the team picks questions from the
corpus). Note that the server must be reachable over public HTTPS for Copilot Studio
(mention a tunnel like `ngrok`/Cloudflare Tunnel as the demo-day option).

## 10. Out of scope (do NOT build)

- OAuth 2.1 / Entra ID auth (phase 2, gallery submission only).
- Any MCP *resources* or *prompts* — tools only.
- Answer synthesis, HyDE, reranking changes, or any new LLM calls.
- Frontend changes. Ingestion/pipeline changes. Qdrant schema changes.
- Microsoft gallery submission paperwork.

## 11. Suggested implementation order

1. `backend/services/runtime.py` — move `get_searcher`, extract dedup + stats helpers;
   `backend/main.py` updated to use them (pure refactor, API behaviour unchanged).
2. `backend/mcp_server.py` with the 4 tools + mounting + lifespan in `main.py`.
3. Smoke-test by hand with MCP Inspector against live Qdrant (test spec Section 3).
4. Pytest suite per `docs/MCP_SERVER_TESTING.md`.
5. `docs/MCP_COPILOT_STUDIO_SETUP.md` + README section.
6. Run the full checklist in `docs/MCP_SERVER_TESTING.md` and record results in that
   file's sign-off table.

## 12. Acceptance criteria (reviewer checklist)

- [ ] `POST /mcp` completes MCP `initialize` → `tools/list` shows exactly the 4 tools with
      correct schemas and English descriptions noting the Arabic corpus.
- [ ] `search_articles` returns deduplicated, reranked results identical in ordering to
      `/api/search` for the same query/filters (shared code path, not a reimplementation).
- [ ] No code path under `/mcp` imports or calls `synthesis`, `chat`, `corpus_chat`, or
      `hyde` modules.
- [ ] Invalid `doc_id` strings (including `../`, absolute paths, wrong format) are rejected
      before any filesystem access.
- [ ] With `API_KEY` set, `/mcp` without the header → 401; with header → works.
- [ ] `MCP_ENABLED=false` boots the API with no `/mcp` route and no MCP imports executed.
- [ ] Existing endpoints (`/api/search`, `/api/chat/corpus`, PDF/OCR/image routes) behave
      exactly as before (regression suite green).
- [ ] All tests in `docs/MCP_SERVER_TESTING.md` implemented and passing; sign-off table filled.
- [ ] `README.md` and `docs/MCP_COPILOT_STUDIO_SETUP.md` written.
- [ ] No new LLM dependencies; only `mcp` added to requirements.
