# AI-Search-Mandumah - ingest & embedding pipeline

Builds the Qdrant collections that the live site (`/home/appuser/AI-Search`) searches:
`mandumah_v2` and `mandumah_ocr_v1` (Azure DI OCR JSON from S3 → chunks → OpenAI
`text-embedding-3-small` 1536d + Arabic sparse vectors → Qdrant).

- Pipeline code: `backend/pipeline/` (`ingest.py`, `chunker.py`, `embedder.py`, `stage_ocr_from_s3.py`, `create_ocr_collection.py`)
- Run/resume ingest safely: `content_shards/run_ingest_safe.sh` (with `watchdog_ingest.py`)
- Status: `content_shards/vdb_status.sh [--watch]`, `content_shards/ocr_dashboard.sh`
- Retrieval regression evals: `content_shards/eval_corpus.py`, `eval_ocr_retrieval.py`
- S3 layout / doc store notes: `docs/`
- Tests: `backend/tests/test_ingest_jsonl.py`

The old standalone web app that used to live here is in `_archive/` (see its README).
