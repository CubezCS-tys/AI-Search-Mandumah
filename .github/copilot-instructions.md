# AI-Search-Mandumah — Copilot Standing Instructions

Arabic academic search & chat platform over the Mandumah journal corpus.
Two product modes: **Search** (per-query results + cross-source synthesis) and
**Chat** (corpus-wide, multi-turn, persistent history).

## Autonomy contract

When asked to "keep going" / "work the roadmap":
1. Pick the top unchecked item from `ROADMAP.md`.
2. Implement it production-grade (no stubs, no TODOs left behind).
3. Verify (see below). Fix anything you broke.
4. Commit with a clear, scoped message.
5. Move to the next item. Repeat until told to stop or the list is empty.

Stop and ask ONLY if a decision is genuinely ambiguous, destructive, or changes
product behavior in a user-visible, non-obvious way. Otherwise keep moving.

## Architecture

- **Backend**: FastAPI, entrypoint `backend.main:app` (run `uvicorn backend.main:app --workers 2`). Python 3.12, venv at `.venv`.
- **Embeddings/LLM**: OpenAI `text-embedding-3-small` (1536-dim); `gpt-4o-mini` for chat/synthesis.
- **Vector DB**: Qdrant, collection from env `COLLECTION_NAME` (default `academic_articles_v2`). Hybrid dense+sparse + RRF fusion + rerank.
- **Persistence**: SQLite (`sqlite3`), DB at env `CHAT_DB_PATH` (default `./storage/conversations.db`), WAL mode for multi-worker safety.
- **Frontend**: Next.js 16 App Router, React 19, Tailwind v4, RTL/Arabic-first. API base `process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"`.

## Conventions (follow without being reminded)

- **RTL / Arabic-first.** UI text in Arabic. Wrap Latin/numeric values (doc_id, scores, times) in `dir="ltr"`.
- **Theme**: Tailwind v4 CSS tokens — `text-text-primary`, `text-text-muted`, `bg-bg-elevated`, `border-border-subtle`. Accent burgundy `#9B1B30`. Fonts `font-arabic` (Tajawal) + Inter.
- **SSE format**: lines `data: {json}\n\n`, terminal `data: [DONE]`. Events: `{"token":...}`, `{"sources":[...]}`, `{"conversation_id":...}`, `{"error":...}`.
- **TypeScript**: type everything, avoid `any`. `"use client"` where needed.
- **ReactMarkdown during streaming**: keep custom renderer component identity stable via refs (updated in effects, never during render) to avoid DOM reconciliation crashes.
- **No new npm/pip dependencies** without asking.

## Verification (run silently, fix failures before committing)

- After **backend** edits: `source .venv/bin/activate && python -c "import backend.main; print('OK')"`.
- After **frontend** edits: from `frontend/`, `npx tsc --noEmit` (must exit 0). Lint changed files; fix only issues you introduced, ignore pre-existing warnings.
- `python` is not on PATH — always use `python3` or activate `.venv` first.
- Workspace-wide `grep` times out on the huge `output/` data dirs — always scope searches with an include pattern.

## Guardrails

- **Never commit data**: `output/`, `output_batch*/`, `output_batch*.zip`, `storage/`, `snapshots/`, `*.snapshot`, `qdrant/` are gitignored — keep it that way.
- Don't clobber live history: deployment rsync must exclude `storage/conversations.db*`.
- No destructive git/infra ops (force push, reset --hard, dropping data) without explicit confirmation.
- Commit in logical, scoped chunks with descriptive messages.

## Known deferred work

- Per-user session/cookie scoping — history is currently global/shared. Required before launching to separate real users. (User deferred; don't implement unless asked.)
- `/api/chat` (per-doc) and synthesis still use the sync OpenAI client (not a bottleneck).
