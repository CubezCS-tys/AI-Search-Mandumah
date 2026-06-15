# Document store — S3-backed source files + local cache

How the platform serves a search result's **original document** (searchable PDF
+ OCR overlay) at scale, decoupling storage (S3) from serving (the app).

## What the viewer actually needs

The in-app viewer does **not** stream the PDF to the browser. For a `doc_id` it requests:

- `GET /api/document/{doc_id}/page/{n}/image` — the backend rasterizes one PDF page to WebP (200 DPI) with PyMuPDF.
- `GET /api/document/{doc_id}/ocr` — word/line bounding boxes (from the OCR JSON) for the text overlay/highlighting.
- `GET /api/pdf/{doc_id}` — the raw PDF, used **only** by the "Download PDF" button.

So the backend needs **random-access reads** of each `{doc_id}.pdf` and `{doc_id}.json`. The `.html` files are not used by the viewer.

## Storage layout (S3)

Files live in S3, one "folder" per document, addressed by `doc_id` only:

```
s3://<DOC_S3_BUCKET>/<DOC_S3_PREFIX>/<doc_id>/<doc_id>.pdf
s3://<DOC_S3_BUCKET>/<DOC_S3_PREFIX>/<doc_id>/<doc_id>.json
```

The current bucket (`mandumah-source-docs`, `eu-north-1`) keys at the **root**, i.e. `DOC_S3_PREFIX` is **empty**: `s3://mandumah-source-docs/<doc_id>/<doc_id>.pdf`. The app must never need the source batch name to build a key — resolution is by `doc_id` alone.

## Request flow

```
Browser → FastAPI endpoint → ensure_doc_file_async(doc_id, file)
                                  │
                 ┌── local doc dir? ──► return (legacy/local installs)
                 ├── local cache hit? ─► return (fast, default pool)
                 └── miss → download pool → S3 → save to cache → return
                                  │
        PyMuPDF renders page → WebP   /   OCR JSON → boxes
```

`ensure_doc_file_async` (in `backend/services/runtime.py`) is the single choke
point every serving endpoint goes through. The rendering code is unchanged — it
just receives a local path that may have come from S3.

## Cache tiers (origin hit as rarely as possible)

```
Browser cache (Cache-Control)              ← repeat views, same user
  └─ In-memory rendered images (200)       ← _page_image_cache: skip re-render
  └─ In-memory OCR pages (24 docs)         ← _ocr_pages_cache: skip 3-9MB re-parse
        └─ Local disk file cache (LRU, ~20GB) ← .doc_cache: skip S3 re-download
             └─ S3 (origin)                ← only on a true cold miss
```

## Production hardening (built for scale)

- **Isolated download pool** — S3 downloads run on a dedicated bounded
  `ThreadPoolExecutor` (`DOC_DOWNLOAD_WORKERS`), so a burst of slow ~MB fetches
  can't starve the default executor that renders pages. Cache **hits** resolve
  on the default pool (never queue behind a download).
- **S3 client config** — `max_pool_connections`, 5s connect / 30s read timeouts,
  adaptive retries (a hung S3 call can't pin a worker forever).
- **Per-doc download lock** — one download per `doc_id` at a time (no thundering
  herd). Lock map is a size-capped LRU (`_DOC_LOCKS_MAX`) — bounded memory.
- **Negative cache** — a missing/404 `doc_id` is remembered for
  `DOC_NEG_CACHE_TTL` seconds so it doesn't re-hit S3 on every request.
- **Atomic downloads** — write to a per-thread `.tmp` then `os.replace`, so a
  partial/failed download is never served.
- **Bounded LRU disk cache** — evicts least-recently-used doc dirs over the cap.
  Eviction uses an **incremental byte counter** (full scan only when over the
  cap, not every download) and a `_EVICT_GRACE` window so a file being served
  isn't deleted mid-stream.
- **OCR pages cache** — the assembled OCR pages are cached per doc; the multi-MB
  JSON is parsed once, not on every `/ocr` request.
- **Graceful fallback** — if `DOC_S3_BUCKET` is unset, behaviour is unchanged
  (local dirs only); a missing PDF degrades the OCR raster dims to best-effort.

## Configuration (environment variables)

| Var | Default | Purpose |
|---|---|---|
| `DOC_S3_BUCKET` | — (unset = local-only) | Source bucket. Enables S3 mode. |
| `DOC_S3_PREFIX` | `docs` (set **empty** for current bucket) | Key prefix before `{doc_id}/`. |
| `DOC_S3_REGION` | (boto3 default) | e.g. `eu-north-1`. |
| `DOC_CACHE_DIR` | `<repo>/.doc_cache` | Local cache directory (gitignored). |
| `DOC_CACHE_MAX_GB` | `20` | Disk cache cap; LRU eviction over this. |
| `DOC_DOWNLOAD_WORKERS` | `8` | Max concurrent S3 downloads. |
| `DOC_S3_MAX_POOL` | `50` | boto3 connection pool size. |
| `DOC_NEG_CACHE_TTL` | `60` | Seconds to remember a missing doc. |
| `OCR_PAGES_CACHE_MAX` | `24` | Docs' parsed OCR pages kept in memory. |
| AWS creds | `~/.aws/credentials` or `AWS_*` | Needs `s3:GetObject` (read-only). |

Example (production backend):

```bash
DOC_S3_BUCKET=mandumah-source-docs DOC_S3_REGION=eu-north-1 DOC_S3_PREFIX= \
DOC_CACHE_DIR=/var/lib/mandumah/.doc_cache DOC_CACHE_MAX_GB=40 \
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

## Operational notes

- Use a **read-only** IAM user (`s3:GetObject`) for the app — not the uploader's
  write keys.
- Cold-fetch latency is bound by file size (an 11MB PDF ≈ ~7s on first view);
  warm views are local-disk fast. Pre-warming popular docs is a future option.
- `DOC_CACHE_MAX_GB` ÷ avg-doc-size bounds how many docs sit in the cache; at
  ~20MB/doc and 20GB that's ~1000 docs, so the flat cache dir stays small.
- **Future:** `/ocr` returns all pages at once — large for long docs. A per-page
  OCR endpoint (+ viewer change) is tracked separately.
