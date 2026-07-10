# Corpus → S3 Upload Runbook (Windows desktop)

Operator-level runbook for uploading the ~6 TB raw corpus to S3 from the
Windows 10 desktop, one zip at a time: **extract → upload per-document folders →
verify → delete the extracted folder → next zip**. The `.zip` files are the
backup and are never deleted.

A ready-to-run implementation of everything below lives at
`scripts/upload_corpus_windows.ps1`. This document is the spec + the operational
knowledge needed to run, verify, and debug it (or reimplement it).

---

## 0. Why this exists / what's true about the setup

- The corpus is packed as **~80 zips** named `output_batchNN.zip`, ~20–60 GB
  each, ~9,500 docs per zip, ~790,000 docs total.
- Inside a zip, each **document** is a folder named by its **doc_id** and holds
  that doc's `.pdf`, `.json`, and `.html`. Example doc folder:
  `0005-075-001-002/` → `0005-075-001-002.pdf`, `.json`, `.html`.
- A doc_id always matches the regex **`^\d{4}-\d{3}-\d{3}-\d{3}$`** (4-3-3-3
  digits). This is the source of truth for finding doc folders — use it, don't
  assume a fixed directory depth.
- Target is **AWS S3** (object storage, no compute — you cannot "extract on the
  server"; extraction happens on the desktop). Bucket **`mandumah-source-docs`**,
  region **`eu-north-1`**.

### The S3 key contract — the single most important rule

The backend (`backend/services/runtime.py`, `ensure_doc_file()`) resolves a
document file as:

```
s3://<bucket>/<prefix>/<doc_id>/<filename>
```

with **prefix empty** on the live bucket (see `docs/doc_store.md`). So the app
expects, for example:

```
s3://mandumah-source-docs/0005-075-001-002/0005-075-001-002.pdf
```

**Root-keyed by doc_id. The `batch/journal/...` structure inside the zip must
NOT appear in the key.** If the upload produces keys like
`output_batch01/.../0005-075-001-002.pdf` or `somejournal/0005-.../....pdf`, the
app will 404 every document. Getting this right is the whole game.

> ⚠️ Code default vs. deployment: `DOC_S3_PREFIX` **defaults to `"docs"`** in
> code but the live deployment uses an **empty** prefix (root). Confirm which is
> in effect before a full run (see §7).

---

## 1. Prerequisites (install once on the desktop)

1. **rclone** — <https://rclone.org/downloads/> (Windows amd64). Put `rclone.exe`
   on `PATH`.
2. **7-Zip** — <https://www.7-zip.org/>. Needed for fast extraction; PowerShell's
   `Expand-Archive` is far too slow for 20–60 GB archives.
3. **Scratch disk** — room for **one** extracted batch. An extracted batch is
   larger than its zip (JSON/HTML expand, PDFs don't), budget **~75 GB free**.
   It is reclaimed after each batch.

### Configure the rclone remote

```powershell
rclone config
#  n) New remote
#  name> s3
#  Storage> s3
#  provider> AWS
#  env_auth> false   (then paste access key + secret)
#  region> eu-north-1
#  (accept defaults for the rest)
```

Verify the remote and bucket are reachable **before** touching data:

```powershell
rclone lsd s3:mandumah-source-docs
```

A non-zero exit or an error here means keys/region/bucket are wrong — stop and
fix; do not start uploading.

---

## 2. Running it

```powershell
.\upload_corpus_windows.ps1 `
    -ZipDir  "D:\output" `          # folder holding output_batchNN.zip
    -WorkDir "D:\_extract_work" `   # scratch (needs ~75 GB free)
    -Remote  "s3" `
    -Bucket  "mandumah-source-docs" `
    -Prefix  "" `                   # EMPTY = bucket root (see the key contract)
    -Transfers 16 `
    -StorageClass STANDARD
```

Process a subset with `-Filter "output_batch0*.zip"`. Leave it running; it logs
to `<WorkDir>\_state\upload.log` and can be interrupted at any time.

---

## 3. The per-zip algorithm (what the script does, in detail)

For each `output_batchNN.zip` in `-ZipDir`, sorted by name:

1. **Skip if done.** If `<WorkDir>\_state\<batch>.done` exists, skip. (Set only
   after a fully verified upload.)
2. **Free-space guard.** Require ≈ `zip_size × 1.6` free on the work drive; abort
   the batch if not.
3. **Extract** to `<WorkDir>\<batch>` (7-Zip `x -y -o<dest>`; `.NET ZipFile`
   fallback). Any previous partial extract dir is deleted first.
4. **Find doc folders.** Recurse the extracted tree for directories whose name
   matches `^\d{4}-\d{3}-\d{3}-\d{3}$`. Zero found ⇒ error (bad layout), stop.
5. **Upload, preserving the key contract:**
   - Compute the set of unique **parent** paths of the doc folders.
   - **Flat layout (one parent):** the doc folders sit directly under one dir →
     a single bulk copy of that parent yields keys `<doc_id>/<file>`:
     ```
     rclone copy "<parent>" "s3:mandumah-source-docs" `
       --transfers 16 --checkers 16 --s3-chunk-size 32M `
       --s3-storage-class STANDARD `
       --exclude Thumbs.db --exclude *.tmp --exclude .DS_Store `
       --stats 30s --stats-one-line
     ```
   - **Nested/mixed layout (multiple parents, e.g. per-journal):** copy each doc
     folder to its own key so no intermediate dir leaks in:
     ```
     rclone copy "<docfolder>" "s3:mandumah-source-docs/<doc_id>" <same flags>
     ```
   (With a non-empty `-Prefix`, the destination base becomes
   `s3:<bucket>/<prefix>`.)
6. **Verify** every source file exists in S3 at matching size:
   ```
   rclone check "<src>" "<dest>" --one-way --size-only
   ```
   `--one-way` ignores extra objects already in the bucket; a non-zero exit means
   something didn't upload → stop, keep the folder.
7. **Reclaim + mark.** Only on a clean verify: delete `<WorkDir>\<batch>` and
   write the `.done` marker. **The zip is never touched.**
8. **Next zip.**

---

## 4. Correctness & safety invariants (do not violate)

- **Never delete a `.zip`.** They are the only backup until S3 is verified
  complete. Only the *extracted* folder is deleted.
- **Delete only after `rclone check` passes.** No verify, no delete.
- **doc_id is the key.** Uploaded keys must be `<doc_id>/<file>` (optionally
  under a configured prefix). Never `batch/...` or `journal/...`.
- **Idempotent / resumable.** Re-running is safe: `.done` markers skip finished
  batches; within a batch, `rclone copy` skips objects already present (size
  match), so an interrupted batch resumes cheaply.
- **Fail closed.** On any error the script stops and leaves the extracted folder
  in place for inspection rather than guessing.

---

## 5. Tuning

- `-Transfers` — parallel object uploads. Start at 16; raise (24–32) if your
  uplink isn't saturated, lower if the connection gets flaky. Small files are
  latency-bound, so concurrency matters more than chunk size here.
- `-StorageClass`:
  - `STANDARD` (default) — no per-GB retrieval fee; safest for files the app
    serves on demand.
  - `STANDARD_IA` — ~45% cheaper storage, but charges per GB retrieved and has a
    30-day minimum. Fine if PDFs are read rarely (the app caches locally).
- Extraction is the other bottleneck; 7-Zip is essential. If the work drive is a
  slow external disk, extract to a local SSD `-WorkDir` instead.

---

## 6. Verifying the result

- **Counts:** total objects should be ≈ docs × files-per-doc. Spot-check a batch:
  ```powershell
  rclone size s3:mandumah-source-docs
  rclone ls  s3:mandumah-source-docs | Select-String "0005-075-001-002"
  ```
- **Key shape:** a listing line must look like
  `0005-075-001-002/0005-075-001-002.pdf`, i.e. the doc_id is the **first** path
  segment. If you see a batch/journal name first, the layout detection went down
  the wrong branch — stop and fix before continuing.
- **End-to-end:** once `DOC_S3_BUCKET` is set on the backend (§7), open a
  document in the app; a cache-miss fetch that renders the PDF confirms the key
  contract end-to-end.

---

## 7. Before the full run — confirm with a human / operator

The live backend (`:8009`, loading this repo's root `.env`) currently has **no
`DOC_S3_BUCKET` set**, so S3 document-serving is not switched on yet, and the
prefix isn't pinned in config. Resolve these first:

1. **Bucket name** — confirm `mandumah-source-docs` (or the intended bucket).
2. **Prefix** — confirm **empty/root** (matches `docs/doc_store.md`), i.e. pass
   `-Prefix ""`. Do **not** silently rely on the code's `"docs"` default.
3. **Dry run** — process one batch, then eyeball a few resulting keys (§6) before
   committing all ~80.
4. **Enable S3 mode on the backend** once uploads are underway/verified: set in
   `.env` and restart the service —
   ```
   DOC_S3_BUCKET=mandumah-source-docs
   DOC_S3_REGION=eu-north-1
   DOC_S3_PREFIX=            # empty for root; must match how you uploaded
   ```
   (Also ensure the backend host has AWS credentials available to boto3.)

---

## 8. Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `Cannot reach s3:...` at start | rclone keys/region/bucket wrong | Re-run `rclone config`; `rclone lsd` must succeed |
| Keys have `batch`/`journal` prefix | wrong upload branch / wrapper dir | Confirm doc-folder detection uses the regex; the bulk copy source must be the doc folders' direct parent |
| App 404s every PDF after upload | prefix mismatch (`docs` vs root) | Make `DOC_S3_PREFIX` on the backend match the uploaded prefix |
| Verify fails on a batch | interrupted/partial upload | Just re-run; rclone resumes, then re-verifies. Folder was kept |
| Extraction very slow / OOM | using `Expand-Archive` | Install 7-Zip; the script auto-detects it |
| "Low disk" abort | work drive too small | Point `-WorkDir` at a bigger/local disk (~75 GB free) |
| Upload slow despite good link | too few transfers or tiny-file latency | Raise `-Transfers`; ensure you're uploading, not re-listing |

---

## 9. Scope note

This uploads the **raw per-document files** (Track B in
`docs/S3_INGESTION_PLAN.md`) needed for **serving** PDFs/HTML. It is *not*
required to start embedding — embedding only needs the ~25 GB of gzipped
`content` shards (Track A). If embedding hasn't started, do Track A first; this
6 TB upload runs in the background and never blocks it.
