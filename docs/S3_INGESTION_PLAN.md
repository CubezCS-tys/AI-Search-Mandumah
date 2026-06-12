# S3 Corpus Ingestion Plan

Goal: embed the full ~6 TB corpus (PDF + Azure DI JSON + HTML, currently on an
external drive attached to a laptop) into the Qdrant collection on the bare
metal server, with S3 as the permanent home for the raw files. The bare metal
server (~1.5–2 TB disk) holds only the vector database.

---

## Key insight: embedding does not need the 6 TB

The ingestion pipeline (`backend/pipeline/ingest.py`) consumes only:

| Input | Source | Confirmed at |
|---|---|---|
| `content` (full text) | Azure DI JSON | `chunker.chunk_document(content, doc_id)` |
| `doc_id` | directory/file name | `_extract_metadata_from_path()` |
| journal/volume/issue metadata | parsed from the doc ID itself | `ingest.py:197` |
| title | derived by the chunker from the content | `result.title` |

The PDF and HTML are never read during ingestion, and of the average 4.7 MB
JSON, only the ~63 K-char `content` string (~125 KB UTF-8) is used — the rest
is Azure DI layout geometry.

So the plan splits into two independent tracks:

- **Track A (fast, ~25 GB):** extract `content` from every JSON on the laptop
  into compact gzipped JSONL shards, upload those, and start embedding within
  hours.
- **Track B (slow, 6 TB):** upload the full raw corpus to S3 in the background
  over days; it is needed for serving PDFs/HTML in the app, not for embedding.

---

## Measured corpus numbers (from the local `output/` sample, n=80 docs)

| Metric | Value |
|---|---|
| Avg JSON / PDF / HTML per doc | 4.7 MB / 1.8 MB / 1.1 MB |
| Avg total per doc | 7.6 MB |
| Estimated docs in 6 TB | **~790,000** |
| Avg `content` length | 63,453 chars (median 54,612) |
| Estimated chunks (≈40/doc at 1600 chars) | **~32 M** |
| Estimated embedding tokens (≈460/chunk incl. overlap+title) | **~14.5 B** |

### Cost & capacity estimates

| Item | Estimate |
|---|---|
| Embedding (text-embedding-3-small, $0.02/1M tok) | **~$290** one-time (~$145 via OpenAI Batch API) |
| Embedding wall-clock at 5M TPM rate limit | ~2 days continuous |
| Qdrant disk (32M pts: f32 on-disk + INT8 quant + payload + sparse + HNSW) | **~400–700 GB** — fits the bare metal server |
| S3 storage, 6 TB Standard-IA | ~$77/month (Standard ~$138, Glacier IR ~$24) |
| S3 PUT requests (~2.4 M objects) | ~$12–25 one-time |
| Ingest egress from S3 (Track A shards only, ~25 GB) | ~$2 |

> **Egress caveat:** AWS egress is $0.09/GB. Re-downloading the full raw 6 TB
> would cost ~$540. If bulk re-reads or heavy PDF serving are expected,
> Cloudflare R2 ($15/TB-mo, free egress) or Backblaze B2 ($6/TB-mo) are
> drop-in S3-compatible alternatives (rclone and boto3 both work unchanged).
> This plan assumes AWS S3 as chosen.

---

## S3 bucket layout

```
s3://<bucket>/
  raw/<batch_dir>/<doc_id>/<doc_id>.json      ← Track B, mirror of the drive
  raw/<batch_dir>/<doc_id>/<doc_id>.pdf
  raw/<batch_dir>/<doc_id>/<doc_id>.html
  content/<batch_dir>.jsonl.gz                ← Track A, one shard per batch dir
  manifests/extract_manifest.json             ← written by the extraction script
```

- Bucket: private, Block Public Access on, default SSE-S3 encryption,
  versioning **off** (write-once data).
- Storage class: `STANDARD` for `content/`; `STANDARD_IA` for `raw/`
  (or a lifecycle rule transitioning `raw/` to Glacier Instant Retrieval
  after 30 days if PDF click-through volume turns out to be low).
- IAM: one user/key for the laptop (PutObject/ListBucket only) and one for
  the bare metal server (GetObject/ListBucket only).

Shard format (`content/<batch_dir>.jsonl.gz`), one line per document:

```json
{"doc_id": "0005-076-003-002", "batch": "output_0005", "content": "..."}
```

---

## Drive reality (observed 2026-06-12)

The external drive is attached to a **Windows** laptop (`My Passport (D:)`).
Much of the corpus is stored as **zip archives** (`output_batchXX.zip`,
~20–60 GB each, ~9.5 K docs per zip, internal layout
`output_batchXX/<doc_id>/<doc_id>.{json,pdf,html}`), spread across more than
one location (`D:\output\` holds zips; some `output_batchXX` folders also sit
at the drive root). The extraction script reads zips in place — **do not
extract them first.**

## Track A — content extraction & upload (laptop)

1. Copy `scripts/extract_content.py` (in this repo, stdlib-only, Python 3.9+,
   no pip installs) to the laptop and run it against each corpus location:

   ```powershell
   py extract_content.py --input-root D:\output --out-dir D:\content_shards --workers 4
   py extract_content.py --input-root D:\ --out-dir D:\content_shards --workers 4   # root-level batch folders
   ```

   - A "batch" is a top-level directory **or** `.zip` archive; one
     `*.jsonl.gz` shard per batch, written atomically; re-running (or running
     multiple roots into one out-dir) skips shards that already exist, which
     also deduplicates a batch present both as zip and extracted folder.
   - Handles flat (`batch/doc_id/doc_id.json`), nested
     (`batch/journal/doc_id/doc_id.json`), and zipped layouts.
   - Hidden/system dirs (`System Volume Information`, `$RECYCLE.BIN`, …) and
     the out-dir itself are skipped; a failing batch is logged to
     `extract_errors.log`, never fatal.
   - Writing the shards to the external drive itself is fine (~25 GB of
     writes vs ~3.7 TB of reads); keep `--workers` at ~4 on a USB HDD.
   - Expected output ~25 GB total; runtime is dominated by drive reads
     (≈ 8–14 h — run overnight, re-run to resume after interruption).

2. Upload the shards (fast — done in hours on any reasonable uplink):

   ```bash
   rclone copy ~/content_shards s3:<bucket>/content/ --transfers 8 --progress
   ```

## Track B — full raw upload (laptop, background)

Since the corpus is already packed into ~80 large zips, upload those as-is —
far faster and cheaper than millions of small objects (~80 PUT-multiparts
instead of ~2.4 M PUTs). rclone is resumable (`copy` skips finished files):

```powershell
rclone copy D:\output s3:<bucket>/raw/zips --transfers 4 --s3-chunk-size 64M --s3-storage-class STANDARD_IA --bwlimit "08:00,5M 23:00,off" --log-file rclone_raw.log --log-level INFO --stats 60s
```

(Repeat per corpus location on the drive; batches that exist only as loose
folders upload with the same command pointed at that folder.)

- Trade-off accepted here: zipped objects can't be fetched per-PDF directly.
  Phase 4 (PDF serving) will either extract zips into
  `raw/<batch>/<doc_id>/...` objects server-side (one-time, in AWS, no laptop
  egress) or range-read zip members via their central directory. Decide then;
  the upload format doesn't block embedding either way.
- `--bwlimit` schedule keeps daytime internet usable; tune to taste.
- Wall-clock for 6 TB: ~5.5 days at 100 Mbps up, ~11 days at 50 Mbps,
  ~28 days at 20 Mbps. If the uplink is below ~50 Mbps, consider an AWS
  Snowball Edge import job instead (~$300 flat, ~2 weeks turnaround).
- Verify per batch dir when done: `rclone check /mnt/external_drive s3:<bucket>/raw --one-way --size-only`.
- Keep the external drive as cold backup until verification passes.

---

## Server side — ingestion changes (to implement)

Extend `backend/pipeline/ingest.py` with a **JSONL shard input mode** rather
than S3-aware code. Fetching is a one-liner outside the pipeline:

```bash
aws s3 sync s3://<bucket>/content/ /data/content_shards/   # ~25 GB
python -m backend.pipeline.ingest --input-jsonl /data/content_shards/ \
  --collection academic_articles_v2
```

Implementation notes:

1. `--input-jsonl <dir>`: discover `*.jsonl.gz` shards, stream lines, yield
   `(doc_id, content, meta)` into the existing Stage-1 chunker exactly where
   per-file JSON loading happens today. `_extract_metadata_from_path` gets a
   sibling that parses the same fields from `doc_id` + `batch` directly.
2. Checkpointing: keep the existing doc-id-keyed checkpoint files; they work
   unchanged since doc IDs are globally unique. At ~790 K docs the current
   JSON checkpoint format (~30 MB) is still fine; bump
   `CHECKPOINT_INTERVAL` if checkpoint writes show up in profiling.
3. Memory: shards are streamed line-by-line; the bounded queues already cap
   memory. The paragraph-hash dedup dict is the thing to watch at 32 M
   chunks (~several GB) — consider switching it to a sqlite or shelve store.
4. Scale flags to validate before the full run: `--dry-run` over one full
   shard, then `--limit 1000` live, then full run in tmux.
5. (Later, separate task) Serving: backend endpoint that issues presigned
   GET URLs for `raw/.../<doc_id>.pdf` so the frontend can link to source
   documents without proxying 6 TB through the VPS.

---

## Phases

| Phase | What | Where | Blocks |
|---|---|---|---|
| 0 | Create bucket, IAM keys, install/configure rclone | AWS console + laptop | — |
| 1 | Run `extract_content.py`, upload `content/` shards | laptop | 0 |
| 2 | Implement `--input-jsonl` mode + dry run + full embedding run | server | 1 |
| 3 | Full `raw/` upload (runs in parallel with phase 2), verify, keep drive as backup | laptop | 0 |
| 4 | Presigned-URL PDF serving in the app | server | 3 |
