#!/usr/bin/env python3
"""
Extract the `content` field from Azure DI JSON files into gzipped JSONL shards.

Designed to run on the laptop holding the external drive with the full corpus.
Stdlib only — no pip installs needed. Cross-platform (Linux/macOS/Windows).

Input layouts supported (auto-detected per batch directory):
    flat:    <input_root>/<batch_dir>/<doc_id>/<doc_id>.json
    nested:  <input_root>/<batch_dir>/<journal_dir>/<doc_id>/<doc_id>.json

Output: one shard per top-level batch directory:
    <out_dir>/<batch_dir>.jsonl.gz
    each line: {"doc_id": "...", "batch": "<batch_dir>", "content": "..."}

Resume-safe: shards are written to a .tmp file and renamed on completion;
re-running skips batch dirs whose shard already exists. Failures are logged
to <out_dir>/extract_errors.log and recorded in extract_manifest.json.

Usage:
    python3 extract_content.py --input-root /mnt/external_drive \
        --out-dir ~/content_shards --workers 8
"""

from __future__ import annotations

import argparse
import gzip
import json
import multiprocessing as mp
import sys
import time
from pathlib import Path


def find_doc_jsons(batch_dir: Path) -> list[Path]:
    """Find all <doc_id>/<doc_id>.json files, flat or nested one level deeper."""
    found: list[Path] = []
    for sub in sorted(p for p in batch_dir.iterdir() if p.is_dir()):
        direct = sub / f"{sub.name}.json"
        if direct.exists():
            found.append(direct)
            continue
        # Nested layout: sub is a journal dir containing article dirs
        for article in sorted(p for p in sub.iterdir() if p.is_dir()):
            nested = article / f"{article.name}.json"
            if nested.exists():
                found.append(nested)
    return found


def extract_one(json_path: Path) -> tuple[str, str | None, str | None]:
    """Return (doc_id, content, error). content is None on failure."""
    doc_id = json_path.stem
    try:
        with open(json_path, encoding="utf-8") as f:
            data = json.load(f)
        content = data.get("content")
        if not content:
            return doc_id, None, "empty or missing content field"
        return doc_id, content, None
    except Exception as exc:  # noqa: BLE001 — record and continue
        return doc_id, None, f"{type(exc).__name__}: {exc}"


def process_batch(args: tuple[Path, Path]) -> dict:
    """Extract one batch directory into one shard. Runs in a worker process."""
    batch_dir, out_dir = args
    shard = out_dir / f"{batch_dir.name}.jsonl.gz"
    tmp = out_dir / f"{batch_dir.name}.jsonl.gz.tmp"
    stats = {"batch": batch_dir.name, "docs": 0, "errors": [], "skipped": False}

    if shard.exists():
        stats["skipped"] = True
        return stats

    json_files = find_doc_jsons(batch_dir)
    with gzip.open(tmp, "wt", encoding="utf-8") as out:
        for jf in json_files:
            doc_id, content, err = extract_one(jf)
            if err:
                stats["errors"].append({"doc_id": doc_id, "path": str(jf), "error": err})
                continue
            line = json.dumps(
                {"doc_id": doc_id, "batch": batch_dir.name, "content": content},
                ensure_ascii=False,
            )
            out.write(line + "\n")
            stats["docs"] += 1
    tmp.replace(shard)
    return stats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 2)[1])
    ap.add_argument("--input-root", required=True, type=Path,
                    help="Root directory containing the batch dirs (the external drive)")
    ap.add_argument("--out-dir", required=True, type=Path,
                    help="Where to write the .jsonl.gz shards")
    ap.add_argument("--workers", type=int, default=4,
                    help="Parallel batch workers (default 4; HDDs rarely benefit past 4-8)")
    ap.add_argument("--limit", type=int, default=0,
                    help="Process only the first N batch dirs (for testing)")
    args = ap.parse_args()

    if not args.input_root.is_dir():
        print(f"error: input root not found: {args.input_root}", file=sys.stderr)
        return 1
    args.out_dir.mkdir(parents=True, exist_ok=True)

    batch_dirs = sorted(p for p in args.input_root.iterdir() if p.is_dir())
    if args.limit:
        batch_dirs = batch_dirs[: args.limit]
    print(f"found {len(batch_dirs)} batch dirs under {args.input_root}")

    t0 = time.time()
    total_docs, total_errors, skipped = 0, 0, 0
    manifest: list[dict] = []
    error_log = args.out_dir / "extract_errors.log"

    work = [(b, args.out_dir) for b in batch_dirs]
    with mp.Pool(args.workers) as pool:
        for i, stats in enumerate(pool.imap_unordered(process_batch, work), 1):
            manifest.append({k: stats[k] for k in ("batch", "docs", "skipped")}
                            | {"errors": len(stats["errors"])})
            total_docs += stats["docs"]
            total_errors += len(stats["errors"])
            skipped += stats["skipped"]
            if stats["errors"]:
                with open(error_log, "a", encoding="utf-8") as elog:
                    for e in stats["errors"]:
                        elog.write(json.dumps(e, ensure_ascii=False) + "\n")
            elapsed = time.time() - t0
            rate = i / elapsed * 3600
            status = "skipped (shard exists)" if stats["skipped"] else f"{stats['docs']} docs"
            print(f"[{i}/{len(batch_dirs)}] {stats['batch']}: {status}"
                  f" | total {total_docs} docs, {total_errors} errors"
                  f" | {rate:.0f} batches/h")

    manifest_path = args.out_dir / "extract_manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(
            {"input_root": str(args.input_root), "batches": manifest,
             "total_docs": total_docs, "total_errors": total_errors,
             "skipped_batches": skipped, "elapsed_sec": round(time.time() - t0)},
            f, ensure_ascii=False, indent=2,
        )
    print(f"\ndone: {total_docs} docs, {total_errors} errors, "
          f"{skipped} batches skipped, manifest at {manifest_path}")
    if total_errors:
        print(f"errors logged to {error_log}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
