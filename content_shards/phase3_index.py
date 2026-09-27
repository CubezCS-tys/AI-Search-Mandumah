#!/usr/bin/env python3
"""Phase 3 index build for mandumah_v2: enable HNSW + create the 12 payload indexes,
then poll to completion (search latency is the ground-truth signal). Low-memory:
Qdrant builds per-segment on disk with max_optimization_threads=1.
"""
import time
import requests
from qdrant_client import QdrantClient, models

URL = "http://localhost:6333"
COLL = "mandumah_v2"
IDX = [("doc_id", "keyword"), ("journal_id", "keyword"), ("section", "keyword"),
       ("title", "text"), ("journal", "keyword"), ("authors", "keyword"),
       ("year", "keyword"), ("country", "keyword"), ("database", "keyword"),
       ("category", "keyword"), ("issn", "keyword"), ("keywords", "keyword")]


def avail():
    return int(open("/proc/meminfo").read().split("MemAvailable:")[1].split()[0]) // 1024


def log(m):
    print(f"{time.strftime('%H:%M:%S')} {m}", flush=True)


def search_secs(c, seed):
    b = {"vector": {"name": "dense", "vector": seed.vector["dense"]}, "limit": 5}
    t = time.time()
    try:
        r = requests.post(f"{URL}/collections/{COLL}/points/search", json=b, timeout=90)
        return time.time() - t, r.status_code
    except Exception:
        return time.time() - t, 0


def main():
    c = QdrantClient(url=URL, timeout=300, check_compatibility=False)
    seed = c.scroll(COLL, limit=1, with_vectors=True)[0][0]

    log("enabling HNSW indexing (indexing_threshold=20000, 4 optimizer threads)...")
    c.update_collection(COLL, optimizer_config=models.OptimizersConfigDiff(
        indexing_threshold=20000, max_optimization_threads=4))

    log("queuing 12 payload indexes (async, wait=False)...")
    for f, s in IDX:
        for attempt in range(5):
            try:
                c.create_payload_index(COLL, field_name=f, field_schema=s, wait=False)
                log(f"  queued {f}")
                break
            except Exception as e:
                if attempt == 4:
                    log(f"  ! {f}: {e}")
                else:
                    time.sleep(5)

    log("waiting for build (polls search latency + status)...")
    t0 = time.time()
    while time.time() - t0 < 4 * 3600:
        info = c.get_collection(COLL)
        secs, code = search_secs(c, seed)
        log(f"  status={info.status} indexed={info.indexed_vectors_count:,} "
            f"search={secs:.2f}s(http {code}) avail={avail()}MB")
        if info.status == "green" and code == 200 and secs < 2.0:
            log(f"INDEX BUILD DONE in {(time.time()-t0)/60:.0f}min. "
                f"points={info.points_count:,} indexed={info.indexed_vectors_count:,} "
                f"payload_idx={list((info.payload_schema or {}).keys())}")
            return 0
        time.sleep(60)
    log("timed out waiting for index build")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
