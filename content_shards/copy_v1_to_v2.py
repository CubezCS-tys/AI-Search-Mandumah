#!/usr/bin/env python3
"""Corruption-tolerant copy of the LIVE, READABLE points from v1 -> v2.

Why this shape (learned the hard way): `mandumah_v1` is red because some points have
orphaned/corrupt vectors. Reading such a vector panics Qdrant's request handler and drops
the connection ("Server disconnected"), and a single bad point poisons an entire
scroll/retrieve batch. So we cannot scroll-with-vectors.

Instead:
  * TRAVERSE with an ids-only scroll -- never reads vectors, so it is always reliable/fast.
  * FETCH vectors with `retrieve`; if a batch fails, bisect it down to isolate the individual
    unreadable id(s), copy every good point, and SKIP the bad one (logging its id + doc_id to
    copy_skipped.jsonl so it can be re-embedded from source later).
  * UPSERT good points to v2 (wait=True; idempotent by id -> crash/resume safe).

Single-worker + pipelined (ids producer thread / fetch+upsert consumer). Resumable via a
cursor checkpoint. This box is memory-bound, so we deliberately avoid heavy concurrency.
"""
import argparse
import json
import os
import queue
import signal
import sys
import threading
import time

from qdrant_client import QdrantClient, models

_STOP = False
ATTEMPTS = 6  # connection-drop retries for the ids-scroll / upsert paths (recreate client between)


def _handle_stop(signum, frame):
    global _STOP
    _STOP = True   # keep the handler tiny: no I/O here (print() would reenter buffered stdout)


def _save_cursor(path, cursor, copied, traversed, skipped):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"cursor": cursor, "copied": copied, "traversed": traversed,
                   "skipped": skipped, "ts": time.time()}, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _load_cursor(path):
    if not os.path.exists(path):
        return None, 0, 0, 0
    try:
        with open(path) as f:
            d = json.load(f)
        return d.get("cursor"), int(d.get("copied", 0)), int(d.get("traversed", 0)), int(d.get("skipped", 0))
    except Exception as e:
        print(f"WARNING: bad checkpoint {path}: {e}; starting fresh", file=sys.stderr, flush=True)
        return None, 0, 0, 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--qdrant-url", default="http://localhost:6333")
    ap.add_argument("--source", default="mandumah_v1")
    ap.add_argument("--target", default="mandumah_v2")
    ap.add_argument("--page", type=int, default=512, help="ids-scroll + retrieve batch size")
    ap.add_argument("--start-id", default=None)
    ap.add_argument("--max-points", type=int, default=0, help="stop after traversing N points (0=all)")
    ap.add_argument("--checkpoint", default="content_shards/copy.cursor.json")
    ap.add_argument("--skip-log", default="content_shards/copy_skipped.jsonl")
    ap.add_argument("--log-every", type=int, default=100)
    args = ap.parse_args()

    global _STOP
    signal.signal(signal.SIGINT, _handle_stop)
    signal.signal(signal.SIGTERM, _handle_stop)

    def new_client():
        return QdrantClient(url=args.qdrant_url, timeout=300, check_compatibility=False)

    client = new_client()
    cursor, copied, traversed, skipped = _load_cursor(args.checkpoint)
    if cursor is None:
        cursor = args.start_id
    src_total = args.max_points or (client.get_collection(args.source).points_count or 0)
    print(f"source={args.source} target={args.target} denom={src_total} "
          f"resume_from={'START' if cursor is None else cursor} "
          f"copied={copied} traversed={traversed} skipped={skipped}", flush=True)

    # Producer: ids-only scroll (reliable). Queues (ids, next_cursor); None = end.
    q: "queue.Queue" = queue.Queue(maxsize=8)
    perr = []

    def producer():
        rc = new_client()
        cur = cursor
        try:
            while not _STOP:
                ids = nxt = None
                for a in range(ATTEMPTS):
                    try:
                        pts, nxt = rc.scroll(args.source, limit=args.page, offset=cur,
                                             with_payload=False, with_vectors=False)
                        ids = [p.id for p in pts]
                        break
                    except Exception as e:
                        if a == ATTEMPTS - 1:
                            raise
                        try: rc.close()
                        except Exception: pass
                        time.sleep(min(20, 2 * (a + 1))); rc = new_client()
                if not ids:
                    break
                q.put((ids, nxt))
                if nxt is None:
                    break
                cur = nxt
        except Exception as e:
            perr.append(e)
        finally:
            q.put(None)

    threading.Thread(target=producer, daemon=True).start()

    skip_fh = open(args.skip_log, "a")

    def fetch_good(ids):
        """Retrieve ids with vectors; bisect around unreadable points, skipping them."""
        nonlocal client, skipped
        try:
            return client.retrieve(args.source, ids=ids, with_payload=True, with_vectors=True)
        except Exception:
            try: client.close()
            except Exception: pass
            client = new_client()
            if len(ids) == 1:
                doc = None
                try:
                    pl = client.retrieve(args.source, ids=ids, with_payload=True, with_vectors=False)
                    doc = pl[0].payload.get("doc_id") if pl else None
                except Exception:
                    pass
                skip_fh.write(json.dumps({"id": str(ids[0]), "doc_id": doc}) + "\n"); skip_fh.flush()
                skipped += 1
                return []
            mid = len(ids) // 2
            return fetch_good(ids[:mid]) + fetch_good(ids[mid:])

    t0 = time.time()
    batches = 0
    while True:
        item = q.get()
        if item is None:
            break
        ids, nxt = item
        if args.max_points and traversed + len(ids) >= args.max_points:
            ids = ids[: args.max_points - traversed]
            nxt = None
        recs = fetch_good(ids)
        if recs:
            struct = [models.PointStruct(id=r.id, vector=r.vector, payload=r.payload) for r in recs]
            for a in range(ATTEMPTS):
                try:
                    client.upsert(args.target, points=struct, wait=True); break
                except Exception as e:
                    if a == ATTEMPTS - 1:
                        raise
                    try: client.close()
                    except Exception: pass
                    time.sleep(min(20, 2 * (a + 1))); client = new_client()
            copied += len(struct)
        traversed += len(ids)
        cursor = nxt
        _save_cursor(args.checkpoint, cursor, copied, traversed, skipped)
        batches += 1
        if batches % args.log_every == 0:
            rate = traversed / max(1e-6, time.time() - t0)
            eta = (src_total - traversed) / max(1e-6, rate) / 3600
            print(f"  traversed={traversed:,}/{src_total:,} copied={copied:,} skipped={skipped} "
                  f"rate={rate:.0f}/s eta={eta:.1f}h", flush=True)
        if nxt is None:
            print("Reached end -- copy complete.", flush=True); break
        if _STOP:
            print("Stopped by signal (checkpointed).", flush=True); break

    _STOP = True
    if perr:
        raise perr[0]
    dt = time.time() - t0
    print(f"DONE: copied={copied:,} skipped={skipped} traversed={traversed:,} in {dt/60:.1f}min "
          f"v2_count={client.count(args.target, exact=True).count:,}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
