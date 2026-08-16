#!/usr/bin/env python3
"""Stage OCR'd documents from S3 into JSONL content shards for the ingest pipeline.

The OCR output is Azure Document Intelligence (`prebuilt-read`) JSON stored at
    s3://<bucket>/<doc_id>/<doc_id>.json
with the full text in the top-level `content` field. This job streams the
doc_id prefixes, pulls each JSON, extracts `content`, computes a light quality
signal (mean word confidence + handwritten fraction), applies an optional
filter, and writes {"doc_id", "content"} records into
    <out-dir>/shard_NNNNN.jsonl.gz
which `backend.pipeline.ingest --input-jsonl <out-dir>` consumes unchanged.

Resumable: doc_ids already present in the staging checkpoint are skipped, so the
job can be killed and restarted freely.

Usage:
    python -m backend.pipeline.stage_ocr_from_s3 \
        --bucket mandumah-source-docs --out-dir ocr_shards/ --limit 200
"""
from __future__ import annotations

import argparse
import gzip
import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger("stage_ocr")

CHECKPOINT_FILE = "staging_checkpoint.json"


def _s3_client(region: str | None):
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        region_name=region,
        config=Config(
            max_pool_connections=64,
            connect_timeout=5,
            read_timeout=30,
            retries={"max_attempts": 5, "mode": "adaptive"},
        ),
    )


def _iter_doc_ids(s3, bucket: str, prefix: str):
    """Yield doc_id folder names under the bucket (streaming, paginated)."""
    paginator = s3.get_paginator("list_objects_v2")
    base = f"{prefix.strip('/')}/" if prefix.strip("/") else ""
    for page in paginator.paginate(Bucket=bucket, Prefix=base, Delimiter="/"):
        for cp in page.get("CommonPrefixes", []):
            key = cp["Prefix"]              # e.g. "0001-000-004-003/"
            doc_id = key[len(base):].rstrip("/")
            if doc_id:
                yield doc_id


def _mean_confidence(doc: dict) -> tuple[float, float]:
    """Return (mean_word_confidence, handwritten_fraction) for an Azure DI doc."""
    total = 0.0
    n = 0
    for page in doc.get("pages", []):
        for w in page.get("words", []):
            c = w.get("confidence")
            if c is not None:
                total += c
                n += 1
    mean_conf = (total / n) if n else 0.0

    hw_len = 0
    for st in doc.get("styles", []):
        if st.get("isHandwritten"):
            for sp in st.get("spans", []):
                hw_len += sp.get("length", 0)
    content_len = len(doc.get("content", "") or "")
    hw_frac = (hw_len / content_len) if content_len else 0.0
    return mean_conf, hw_frac


def _fetch_one(s3, bucket: str, prefix: str, doc_id: str) -> dict:
    """Download + parse one OCR JSON. Returns a result dict (never raises)."""
    base = f"{prefix.strip('/')}/" if prefix.strip("/") else ""
    key = f"{base}{doc_id}/{doc_id}.json"
    try:
        obj = s3.get_object(Bucket=bucket, Key=key)
        doc = json.loads(obj["Body"].read())
    except Exception as e:
        return {"doc_id": doc_id, "status": "error", "error": str(e)[:200]}

    content = (doc.get("content") or "").strip()
    if not content:
        return {"doc_id": doc_id, "status": "empty"}

    mean_conf, hw_frac = _mean_confidence(doc)
    return {
        "doc_id": doc_id,
        "status": "ok",
        "content": content,
        "content_len": len(content),
        "mean_conf": round(mean_conf, 4),
        "hw_frac": round(hw_frac, 4),
    }


class ShardWriter:
    """Writes records into rolling gzip shards of `shard_size` docs each."""

    def __init__(self, out_dir: Path, shard_size: int, start_index: int):
        self.out_dir = out_dir
        self.shard_size = shard_size
        self.index = start_index
        self._fh = None
        self._count = 0

    def _open(self):
        path = self.out_dir / f"shard_{self.index:05d}.jsonl.gz"
        self._fh = gzip.open(path, "at", encoding="utf-8")
        return path

    def write(self, rec: dict):
        if self._fh is None:
            self._open()
        self._fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        self._count += 1
        if self._count >= self.shard_size:
            self.close()

    def close(self):
        if self._fh is not None:
            self._fh.close()
            self._fh = None
            self.index += 1
            self._count = 0


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bucket", default="mandumah-source-docs")
    ap.add_argument("--prefix", default="", help="Key prefix above the doc_id folders")
    ap.add_argument("--out-dir", default="ocr_shards", help="Output shard directory")
    ap.add_argument("--region", default=os.getenv("AWS_REGION"))
    ap.add_argument("--limit", type=int, default=0, help="Max docs to stage (0=all)")
    ap.add_argument("--workers", type=int, default=16, help="Concurrent S3 downloads")
    ap.add_argument("--shard-size", type=int, default=2000, help="Docs per shard")
    ap.add_argument("--min-confidence", type=float, default=0.0,
                    help="Drop docs with mean word confidence below this (0=keep all)")
    ap.add_argument("--min-content-len", type=int, default=20,
                    help="Drop docs with fewer than N characters of text")
    ap.add_argument("--exclude-checkpoint", action="append", default=[],
                    help="Path(s) to an ingest_checkpoint.json whose 'processed' "
                         "doc_ids should be skipped (e.g. already embedded in v2). "
                         "Repeatable.")
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    ckpt_path = out_dir / CHECKPOINT_FILE

    done: set[str] = set()
    next_shard = 0
    if ckpt_path.exists():
        ck = json.loads(ckpt_path.read_text())
        done = set(ck.get("done", []))
        next_shard = ck.get("next_shard", 0)
        logger.info("Resuming: %d docs already staged, next shard #%d", len(done), next_shard)

    # Docs already embedded elsewhere (e.g. mandumah_v2) — skip them entirely so
    # v2 and mandumah_ocr_v1 form a clean non-overlapping partition.
    exclude: set[str] = set()
    for ckpt in args.exclude_checkpoint:
        ids = json.loads(Path(ckpt).read_text()).get("processed", [])
        exclude.update(ids)
        logger.info("Excluding %d doc_ids from %s", len(ids), ckpt)
    if exclude:
        logger.info("Total excluded doc_ids: %d", len(exclude))

    s3 = _s3_client(args.region)

    # Build the work list (streaming), skipping already-staged/excluded docs.
    logger.info("Listing doc_id prefixes under s3://%s/%s ...", args.bucket, args.prefix)
    todo: list[str] = []
    for doc_id in _iter_doc_ids(s3, args.bucket, args.prefix):
        if doc_id in done or doc_id in exclude:
            continue
        todo.append(doc_id)
        if args.limit and len(todo) >= args.limit:
            break
    logger.info("%d docs to stage", len(todo))
    if not todo:
        logger.info("Nothing to do.")
        return

    writer = ShardWriter(out_dir, args.shard_size, next_shard)
    lock = threading.Lock()
    stats = {"ok": 0, "empty": 0, "error": 0, "low_conf": 0, "short": 0, "handwritten": 0}
    conf_samples: list[float] = []
    t0 = time.time()

    def flush_checkpoint():
        tmp = ckpt_path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"done": sorted(done), "next_shard": writer.index}))
        os.replace(tmp, ckpt_path)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(_fetch_one, s3, args.bucket, args.prefix, d): d for d in todo}
        for i, fut in enumerate(as_completed(futures), 1):
            r = fut.result()
            with lock:
                st = r["status"]
                if st == "error":
                    stats["error"] += 1
                elif st == "empty":
                    stats["empty"] += 1
                    done.add(r["doc_id"])   # empty is terminal — don't retry forever
                else:
                    conf_samples.append(r["mean_conf"])
                    if r["hw_frac"] >= 0.5:
                        stats["handwritten"] += 1
                    if r["content_len"] < args.min_content_len:
                        stats["short"] += 1
                        done.add(r["doc_id"])
                    elif r["mean_conf"] < args.min_confidence:
                        stats["low_conf"] += 1
                        done.add(r["doc_id"])
                    else:
                        writer.write({"doc_id": r["doc_id"], "content": r["content"]})
                        stats["ok"] += 1
                        done.add(r["doc_id"])
                if i % 500 == 0:
                    flush_checkpoint()
                    rate = i / (time.time() - t0)
                    logger.info("%d/%d (%.0f/s) | kept=%d empty=%d err=%d lowconf=%d short=%d",
                                i, len(todo), rate, stats["ok"], stats["empty"],
                                stats["error"], stats["low_conf"], stats["short"])

    writer.close()
    flush_checkpoint()

    dur = time.time() - t0
    logger.info("=== staging done in %.1fs ===", dur)
    logger.info("stats: %s", stats)
    if conf_samples:
        conf_samples.sort()
        n = len(conf_samples)
        pct = lambda p: conf_samples[min(n - 1, int(p * n))]
        logger.info(
            "confidence distribution: min=%.3f p5=%.3f p25=%.3f median=%.3f p75=%.3f mean=%.3f",
            conf_samples[0], pct(0.05), pct(0.25), pct(0.5), pct(0.75),
            sum(conf_samples) / n,
        )
    logger.info("shards written to %s (through shard_%05d)", out_dir, max(0, writer.index - 1))


if __name__ == "__main__":
    main()
