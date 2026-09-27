#!/usr/bin/env python3
"""Compute an even N-way partition of the live points in a Qdrant collection.

One fast ids-only scroll (~24k/s) walks the collection in its native order and records
the point id at each slice boundary (position i*K). Each worker then copies exactly its
slice via `copy_v1_to_v2.py --start-id <boundary> --max-points <K>` -- partitioning by
COUNT, not by id value, so it is robust to however Qdrant orders ids. Slices are
contiguous and non-overlapping, so together they cover every live point exactly once.

Writes the plan to content_shards/copy_plan.json.
"""
import argparse
import json
import time

from qdrant_client import QdrantClient


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--qdrant-url", default="http://localhost:6333")
    ap.add_argument("--source", default="mandumah_v1")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--out", default="content_shards/copy_plan.json")
    args = ap.parse_args()

    c = QdrantClient(url=args.qdrant_url, timeout=300, check_compatibility=False)

    # Pass 1: exact live count (ids-only scroll is fast).
    print("counting live points (ids-only scroll)...", flush=True)
    t = time.time()
    total = 0
    cur = None
    while True:
        pts, cur = c.scroll(args.source, limit=20000, offset=cur, with_payload=False, with_vectors=False)
        if not pts:
            break
        total += len(pts)
        if cur is None:
            break
    print(f"live points = {total:,} (in {time.time()-t:.0f}s)", flush=True)

    K = -(-total // args.workers)  # ceil division -> slice size
    targets = {i * K: idx for idx, i in enumerate(range(args.workers))}  # position -> worker idx

    # Pass 2: record the boundary id at each slice start position.
    print("locating slice boundaries...", flush=True)
    boundaries = [None] * args.workers  # start_id per worker (worker 0 -> None = true start)
    pos = 0
    cur = None
    remaining = dict(targets)
    while remaining:
        pts, cur = c.scroll(args.source, limit=20000, offset=cur, with_payload=False, with_vectors=False)
        if not pts:
            break
        for hit in remaining.copy():
            if pos <= hit < pos + len(pts):
                boundaries[remaining[hit]] = str(pts[hit - pos].id)
                del remaining[hit]
        pos += len(pts)
        if cur is None:
            break

    plan = {"source": args.source, "total": total, "workers": args.workers, "slices": []}
    for i in range(args.workers):
        start = 0 if i == 0 else None  # placeholder
        max_points = min(K, total - i * K)
        if max_points <= 0:
            continue
        plan["slices"].append({
            "worker": i,
            "start_id": (None if i == 0 else boundaries[i]),
            "max_points": max_points,
            "checkpoint": f"content_shards/copy.cursor.{i}.json",
            "log": f"content_shards/copy.worker{i}.log",
        })

    with open(args.out, "w") as f:
        json.dump(plan, f, indent=2)
    print(f"wrote {args.out}: {len(plan['slices'])} slices of ~{K:,} points each", flush=True)
    for s in plan["slices"]:
        print(f"  worker {s['worker']}: start_id={s['start_id']} max_points={s['max_points']:,}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
