# S3 Upload Guide — Source Documents

How to upload the source document batches (searchable PDFs + JSON + HTML) from the
external drive to S3.

## Target

- **Bucket:** `mandumah-source-docs`
- **Region:** `eu-north-1` (Stockholm)
- **IAM user:** `s3-uploader` (account `006127064053`)

## Key layout

Article folders are uploaded to the **bucket root** — no batch-name prefix. Keys look like:

```
s3://mandumah-source-docs/0005-077-006-001/0005-077-006-001.pdf
s3://mandumah-source-docs/0005-077-006-001/0005-077-006-001.json
s3://mandumah-source-docs/0005-077-006-001/0005-077-006-001.html
```

Article IDs are globally unique, so multiple batches share the bucket without collision.
The ingestion pipeline keys off this `<article-id>/<article-id>.ext` scheme — do **not**
nest under `output_batch*/`.

## One-time setup

Install AWS CLI v2:

```bash
curl -s "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
cd /tmp && unzip -q -o awscliv2.zip
sudo /tmp/aws/install
aws --version   # expect aws-cli/2.x
```

Configure credentials (interactive — enter access key, secret, region `eu-north-1`,
output `json`):

```bash
aws configure
aws sts get-caller-identity   # confirm identity
aws s3 ls                     # confirm bucket is visible
```

Tune for many small files:

```bash
aws configure set default.s3.max_concurrent_requests 20
aws configure set default.s3.region eu-north-1
```

## Upload a batch

`aws s3 sync` uploads the **contents** of the source dir (the article folders) to the
destination — not the source dir itself. It is **resumable**: if it stops or the
connection drops, rerun the exact same command and it skips whatever already uploaded.

```bash
aws s3 sync "/media/cubez/My Passport/output/output_batch01-8" "s3://mandumah-source-docs" 2>&1 | tee ~/s3_upload_batch01-8.log
```

For long uploads, run inside `tmux` or `screen` so it survives closing the terminal.

Source batches live on the "My Passport" external drive under
`/media/cubez/My Passport/output/` (e.g. unzipped `output_batch01-8` ≈ 92 GB, 9,622 folders).
For other batches, swap the source path; keep the destination as the bucket root.

## Verify

```bash
# Sample top-level keys (should be article-ID prefixes, no batch wrapper)
aws s3 ls s3://mandumah-source-docs/ | head

# Total object count + bytes
aws s3 ls s3://mandumah-source-docs/ --recursive --summarize | tail -3

# Spot-check one folder has all three file types
aws s3 ls s3://mandumah-source-docs/0005-077-006-001/
```

Expected per batch: object count ≈ folders × 3 (pdf + json + html).
