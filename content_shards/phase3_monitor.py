#!/usr/bin/env python3
"""READ-ONLY patient monitor for the mandumah_v2 HNSW build. One light poll every 5 min
(so it doesn't add load to the busy optimizer). Reports when dense search is fast + green.
"""
import time
import requests
from qdrant_client import QdrantClient

URL = "http://localhost:6333"
COLL = "mandumah_v2"


def avail():
    return int(open("/proc/meminfo").read().split("MemAvailable:")[1].split()[0]) // 1024


def log(m):
    print(f"{time.strftime('%H:%M:%S')} {m}", flush=True)


def main():
    c = QdrantClient(url=URL, timeout=180, check_compatibility=False)
    seed = None
    t0 = time.time()
    while time.time() - t0 < 6 * 3600:
        try:
            info = c.get_collection(COLL)
            if seed is None:
                seed = c.scroll(COLL, limit=1, with_vectors=True)[0][0]
            b = {"vector": {"name": "dense", "vector": seed.vector["dense"]}, "limit": 5}
            t = time.time()
            r = requests.post(f"{URL}/collections/{COLL}/points/search", json=b, timeout=90)
            secs = time.time() - t
            pidx = list((info.payload_schema or {}).keys())
            log(f"status={info.status} indexed={info.indexed_vectors_count:,} "
                f"search={secs:.2f}s(http {r.status_code}) payload_idx={len(pidx)}/12 avail={avail()}MB")
            if info.status == "green" and r.status_code == 200 and secs < 2.0:
                log(f"HNSW BUILD DONE. indexed={info.indexed_vectors_count:,} payload_idx={pidx}")
                return 0
        except Exception as e:
            log(f"(server busy: {type(e).__name__}) avail={avail()}MB")
        time.sleep(300)
    log("monitor timed out")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
