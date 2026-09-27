# _archive

Moved here on 2026-09-27 instead of being deleted (restore: `git mv _archive/<path> <path>`).

This repo once also held a standalone search/chat web app (FastAPI `backend/main.py` on :8000
plus the Next.js `frontend/`). Nothing runs it: no systemd unit, no nginx route, no process.
The live site is the separate `AI-Search` repo, which has its own copy of the S3 doc store.

What stays live in this repo is the **ingest/embedding pipeline** (`backend/pipeline/`,
`backend/utils/arabic.py`), the search helpers the eval scripts use
(`backend/services/{search,corpus_chat,hyde,openai_client}.py`), the ops scripts in
`content_shards/` (now tracked in git), `eval/`, `scripts/` and `docs/`.

Evidence: import trace from every pipeline module, content_shards/eval/scripts entry point;
after the move all of them import/compile and `backend/tests/test_ingest_jsonl.py` passes (9/9).

| Path | What it was |
|---|---|
| `backend/main.py`, `routers/`, `mcp_server.py`, `services/{chat,synthesis,conversation_store,admin_auth}.py` | the unused web app's API |
| `backend/services/runtime.py` | the original S3 doc store (`ensure_doc_file`); AI-Search reimplemented it as `services/s3_docstore.py`, so this is reference only |
| `backend/tests/test_mcp_*.py`, `perf_mcp.py` | tests for the MCP server |
| `frontend/` | the unused Next.js app (989 MB incl. node_modules/.next) |
| `docs/` | README/ROADMAP/PRODUCTION/MIGRATION_PLAN describing that app and an older collection |
