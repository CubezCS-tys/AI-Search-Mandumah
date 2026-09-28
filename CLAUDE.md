# CLAUDE.md: AI-Search-Mandumah (ingest and embedding pipeline)

This repo **builds** the Qdrant collections `mandumah_v2` and `mandumah_ocr_v1` that the live
site ai.mandumah.com searches. The site itself lives in `/home/appuser/AI-Search`: read its
`CLAUDE.md` and `docs/runbooks/ingest.md` first. Updated 2026-09-28.

## What is live here
- `backend/pipeline/`: `ingest.py` (chunk → OpenAI `text-embedding-3-small` 1536d dense + Arabic
  TF-IDF sparse → upsert), `chunker.py`, `embedder.py`, `stage_ocr_from_s3.py`, `create_ocr_collection.py`.
- `content_shards/` ops scripts (tracked): `run_ingest_safe.sh` (+ `watchdog_ingest.py`),
  `scheduled_stop_ingest.sh`, `vdb_status.sh [--watch]`, `ocr_dashboard.sh`, `eval_corpus.sh`,
  `eval_ocr_retrieval.sh`. The data files in that folder are gitignored.
- The old standalone web app is in `_archive/`. Nothing serves it.

## Hard rules
- **Shared production Qdrant** (`localhost:6333`, v1.7.4). An ingest competes with live search
  for RAM and disk, so agree timing with the owner and run it in tmux.
- Always pass `--collection` (the default `academic_articles_v2` is not a live collection).
  **Never** use `--force-recreate` against a live collection. `--no-resume` re-embeds (costs money).
- Never change collection config (`finalize`, `update_collection`, quantization, HNSW) while the
  optimizer runs. Don't touch `mandumah_v1` (parked, corrupt).
- Stop ingests with SIGINT (the handler checkpoints). Never `kill -9`.
- Contracts shared with AI-Search. A change to any of these is a cross-repo change:
  embedding model and dimensions, dense vector name `dense`, chunk ids `<doc_id>_chunk_NNN` /
  `<doc_id>_chunk_abstract`, payload field names (`doc_id`, `chunk_id`, `text`, `title`, …), and
  the S3 layout `<doc_id>/<doc_id>.{pdf,json,html}` in `mandumah-source-docs`.
- Secrets only in `.env` (gitignored). Refer to them by name.
- Never delete. Archive into `_archive/`.

## After every ingest
1. Wait for `status: green` + `optimizer_status: ok` (`content_shards/vdb_status.sh --watch`).
2. Back up: `sudo systemctl start qdrant-backup@mandumah_v2` (or `@mandumah_ocr_v1`). The
   scripts live in AI-Search `scripts/qdrant/`.
3. If new documents were added, rebuild AI-Search's `data/mandumah_pdf_ids.db`
   (`app_backend/build_mandumah_pdf_ids.py`) so Download/Citation work for them.
4. Retrieval check: `content_shards/eval_corpus.sh --sample 300`, plus a golden run in AI-Search.
