#!/usr/bin/env python3
"""
Extract the `content` field from Azure DI JSON files into gzipped JSONL shards.

Designed to run on the laptop holding the external drive with the full corpus.
Stdlib only — no pip installs needed. Cross-platform (Linux/macOS/Windows).

Input layouts supported (auto-detected per batch; a batch is a directory OR a
zip archive sitting at the top level of --input-root):
    flat dir:   <input_root>/<batch_dir>/<doc_id>/<doc_id>.json
    nested dir: <input_root>/<batch_dir>/<journal_dir>/<doc_id>/<doc_id>.json
    zip:        <input_root>/<batch>.zip containing <prefix>/<doc_id>/<doc_id>.json
Zips are read in place via the zipfile module — nothing is extracted to disk.

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
import re
import sys
import time
import zipfile
from json.decoder import scanstring
from pathlib import Path, PurePosixPath


def find_doc_jsons(batch_dir: Path) -> tuple[list[Path], list[Path]]:
    """Find <doc_id>/<doc_id>.json files, flat or nested one level deeper.

    Returns (found_json_paths, doc_dirs_missing_their_json) so the manifest
    can account for every document folder, not just the extractable ones.
    """
    found: list[Path] = []
    missing: list[Path] = []
    for sub in sorted(p for p in batch_dir.iterdir() if p.is_dir()):
        direct = sub / f"{sub.name}.json"
        if direct.exists():
            found.append(direct)
            continue
        # Nested layout: sub is a journal dir containing article dirs
        articles = sorted(p for p in sub.iterdir() if p.is_dir())
        if not articles:
            missing.append(sub)
            continue
        for article in articles:
            nested = article / f"{article.name}.json"
            if nested.exists():
                found.append(nested)
            else:
                missing.append(article)
    return found, missing


def zip_missing_jsons(names: list[str]) -> list[str]:
    """Doc dirs inside a zip that hold a pdf/html but no matching json."""
    doc_dirs = {PurePosixPath(n).parent for n in names
                if PurePosixPath(n).suffix.lower() in {".pdf", ".html", ".json"}}
    with_json = {PurePosixPath(n).parent for n in names
                 if PurePosixPath(n).suffix == ".json"
                 and PurePosixPath(n).parent.name == PurePosixPath(n).stem}
    return sorted(str(p) for p in doc_dirs - with_json)


_CONTENT_KEY_RE = re.compile(r'"content"\s*:\s*"')


def parse_content(raw: bytes | str, doc_id: str) -> tuple[str, str | None, str | None]:
    """Return (doc_id, content, error). content is None on failure.

    Fast path: Azure DI JSONs are ~4.7 MB but `content` is a single top-level
    string near the start of the file. Parsing just that string with the
    C-accelerated scanner is ~constant in document size, vs json.loads which
    must materialise megabytes of layout data. Falls back to a full parse if
    the pattern is not where we expect it.
    """
    try:
        text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        m = _CONTENT_KEY_RE.search(text, 0, 4096)
        if m:
            content, _end = scanstring(text, m.end())
            if content:
                return doc_id, content, None
        # Fallback: key missing/late, or empty string at the fast-path match
        data = json.loads(text)
        content = data.get("content")
        if not content:
            return doc_id, None, "empty or missing content field"
        return doc_id, content, None
    except Exception as exc:  # noqa: BLE001 — record and continue
        return doc_id, None, f"{type(exc).__name__}: {exc}"


def iter_zip_docs(zf: zipfile.ZipFile, names: list[str], zip_path: Path):
    """Yield (doc_id, raw_json_bytes, source_path) from a batch zip archive.

    Only members shaped like .../<doc_id>/<doc_id>.json count as documents,
    which excludes stray files (metrics, checkpoints) bundled into the zip.
    """
    for name in names:
        p = PurePosixPath(name)
        if p.suffix == ".json" and p.parent.name == p.stem:
            yield p.stem, zf.read(name), f"{zip_path}!{name}"


def process_batch(args: tuple[Path, Path]) -> dict:
    """Extract one batch (directory or zip archive) into one shard."""
    batch_path, out_dir = args
    batch_name = batch_path.stem if batch_path.suffix.lower() == ".zip" else batch_path.name
    shard = out_dir / f"{batch_name}.jsonl.gz"
    tmp = out_dir / f"{batch_name}.jsonl.gz.tmp"
    stats = {"batch": batch_name, "docs": 0, "missing_json": 0,
             "errors": [], "skipped": False}

    if shard.exists():
        stats["skipped"] = True
        return stats

    def write_docs(docs, out) -> None:
        for doc_id, raw, source in docs:
            doc_id, content, err = parse_content(raw, doc_id)
            if err:
                stats["errors"].append({"doc_id": doc_id, "path": source, "error": err})
                continue
            line = json.dumps(
                {"doc_id": doc_id, "batch": batch_name, "content": content},
                ensure_ascii=False,
            )
            out.write(line + "\n")
            stats["docs"] += 1

    try:
        with gzip.open(tmp, "wt", encoding="utf-8") as out:
            if batch_path.suffix.lower() == ".zip":
                with zipfile.ZipFile(batch_path) as zf:
                    names = zf.namelist()
                    missing = zip_missing_jsons(names)
                    write_docs(iter_zip_docs(zf, names, batch_path), out)
            else:
                found, missing_dirs = find_doc_jsons(batch_path)
                missing = [str(p) for p in missing_dirs]
                write_docs(((jf.stem, jf.read_bytes(), str(jf)) for jf in found), out)
        stats["missing_json"] = len(missing)
        for path in missing:
            stats["errors"].append({"doc_id": "", "path": path,
                                    "error": "doc folder has no json file"})
        tmp.replace(shard)
    except Exception as exc:  # noqa: BLE001 — unreadable batch must not kill the run
        stats["errors"].append({"doc_id": "", "path": str(batch_path),
                                "error": f"batch failed: {type(exc).__name__}: {exc}"})
        tmp.unlink(missing_ok=True)
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

    out_resolved = args.out_dir.resolve()
    skip_names = {"System Volume Information", "$RECYCLE.BIN", "FOUND.000", "lost+found"}
    batch_dirs = sorted(
        p for p in args.input_root.iterdir()
        if (p.is_dir() or p.suffix.lower() == ".zip")
        and not p.name.startswith((".", "$"))
        and p.name not in skip_names
        and p.resolve() != out_resolved
    )
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
            manifest.append({k: stats.get(k, 0) for k in ("batch", "docs", "missing_json", "skipped")}
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
