# Handoff: corpus → S3 upload on Ubuntu

You are an agent operating an Ubuntu PC. Your job: get the ~6 TB raw corpus
(~80 `output_batchNN.zip` files on an external drive) into an AWS S3 bucket,
and first tell the human **what's already uploaded vs. missing**, since prior
upload attempts from a Windows machine left the state uncertain.

A tested tool already exists in this repo — **`scripts/upload_corpus.sh`**. Use
it. Do not reimplement unless it's broken. It has a **`--report`** mode that
answers the "what's already up there" question without changing anything.

---

## Ground truth you must not get wrong

- **Documents:** each doc is a folder named by its **doc_id**, regex
  `^\d{4}-\d{3}-\d{3}-\d{3}$` (e.g. `0005-075-001-002`), containing that doc's
  `.pdf`, `.json`, `.html`.
- **S3 key contract:** the app fetches files at
  **`s3://<bucket>/<doc_id>/<file>`** — root-keyed by doc_id, **no**
  `batch/journal/...` in the path. If uploaded keys carry a batch or journal
  prefix, the app 404s every document. The script enforces this (it finds doc
  folders by the regex and copies so the doc_id is the first key segment); your
  job is to verify it (see "Verify" below), not to defeat it.
- **Target:** bucket `mandumah-source-docs`, region `eu-north-1` (confirm with
  the human — see "Open decision").
- **Never delete a `.zip`.** They're the only backup until S3 is verified
  complete. The script only deletes the *extracted* folder, and only after a
  passing `rclone check`.

---

## Setup (once)

```bash
# tools
sudo apt update && sudo apt install -y unzip
curl https://rclone.org/install.sh | sudo bash      # current rclone (apt's is often old)

# S3 remote — needs an AWS access key/secret with write on the bucket
rclone config
#   n) new  ->  name: s3  ->  storage: s3  ->  provider: AWS
#   env_auth: false  ->  paste key + secret  ->  region: eu-north-1  ->  defaults
rclone lsd s3:mandumah-source-docs                  # MUST succeed before proceeding
```

Run everything inside **tmux** so a disconnect doesn't kill a multi-day job:

```bash
tmux new -s upload      # detach with Ctrl-b then d;  reattach: tmux attach -t upload
```

Pick a `--work` scratch dir with **~75 GB free** (holds one extracted batch at a
time; auto-cleaned per batch). Ideally a local SSD, not the external drive.

---

## Step 1 — Report what's already uploaded (do this first)

```bash
./scripts/upload_corpus.sh \
    --zips /mnt/drive/output \
    --work /mnt/drive/_work \
    --report
```

This lists each zip's doc_ids (read from the zip's index, **without
extracting**), diffs them against a live listing of the bucket, and prints a
table: `BATCH | DOCS | IN_S3 | MISSING`, plus a TOTAL row. That's the coverage
picture. Show it to the human. (`--refresh` rebuilds the S3 listing; it's cached
under `<work>/_state/s3_docids.txt`.)

---

## Step 2 — Upload the rest

```bash
./scripts/upload_corpus.sh \
    --zips /mnt/drive/output \
    --work /mnt/drive/_work \
    --prefix ""          # empty = bucket root (see Open decision)
```

Per zip: skip if fully in S3 → else extract → upload doc folders to
`s3://bucket/<doc_id>/…` → `rclone check` (size) → delete the extracted folder →
`.done` marker → next. It is **resumable**: rerun the same command any time;
rclone skips objects already present, `.done` markers skip finished batches.

- Test one batch first: add `--filter "output_batch01.zip"`, then verify a key
  looks right (below) before running the whole set.
- `--verify-existing` — for a cautious first pass that doesn't trust earlier
  partial uploads: never skip on S3-presence, always extract + `rclone copy`
  (file-accurate, fills any half-uploaded doc). Slower; drop it afterward.
- Tuning: `--transfers 24` if the uplink isn't saturated; `--storage STANDARD_IA`
  for cheaper storage (retrieval fees apply). Log: `<work>/_state/upload.log`.

---

## Verify (spot-check the key contract)

```bash
rclone ls s3:mandumah-source-docs | grep 0005-075-001-002
# want lines like:  0005-075-001-002/0005-075-001-002.pdf   (doc_id FIRST)
```

If a batch/journal name appears before the doc_id, **stop** and report it — the
layout detection took the wrong branch and keys are wrong.

---

## Open decision — confirm with the human before the full run

The live backend currently has **no `DOC_S3_BUCKET` set**, so S3 serving isn't
switched on and the prefix isn't pinned. Confirm:

1. Bucket = `mandumah-source-docs` (or whatever they intend).
2. Prefix = **empty/root** (`--prefix ""`), per `docs/doc_store.md` — *not* the
   code's `"docs"` default. Whatever you upload under, the backend's
   `DOC_S3_PREFIX` must later match, or every fetch 404s.
3. After uploads are verified, enable serving: set `DOC_S3_BUCKET`,
   `DOC_S3_REGION=eu-north-1`, `DOC_S3_PREFIX=` in the backend `.env`, ensure the
   host has AWS creds for boto3, and restart the service.

---

## Status of the tool (already done on this repo)

- `scripts/upload_corpus.sh` written, `bash -n` clean, marked executable.
- The report logic was unit-checked: doc_id extraction from a zip via
  `unzip -Z1` and the present/missing diff (`comm`) produce correct counts;
  flat-layout doc-folder detection and single-parent grouping verified.
- Not yet exercised against real S3 (needs the AWS credentials on your box).

This uploads Track B (raw files for serving PDFs/HTML). It is **not** required
to start embedding — embedding only needs the ~25 GB Track A content shards. See
`docs/S3_INGESTION_PLAN.md` and `docs/CORPUS_S3_UPLOAD_RUNBOOK.md` for the
fuller design.
