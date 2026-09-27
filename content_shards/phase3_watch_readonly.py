#!/usr/bin/env python3
"""READ-ONLY watcher for mandumah_v2 convergence. NEVER changes config (that was resetting
the optimizer). Polls status + dense-search latency + memory every 10 min; reports when a
search comes back <2s and green. Up to 8h.
"""
import time, requests
from qdrant_client import QdrantClient

URL="http://localhost:6333"; COLL="mandumah_v2"
def avail(): return int(open("/proc/meminfo").read().split("MemAvailable:")[1].split()[0])//1024
def log(m): print(f"{time.strftime('%H:%M:%S')} {m}", flush=True)

def main():
    c=QdrantClient(url=URL,timeout=120,check_compatibility=False)
    seed=c.scroll(COLL,limit=1,with_vectors=True)[0][0]
    b={"vector":{"name":"dense","vector":seed.vector["dense"]},"limit":5}
    t0=time.time()
    while time.time()-t0 < 8*3600:
        try:
            info=c.get_collection(COLL)
            t=time.time(); r=requests.post(f"{URL}/collections/{COLL}/points/search",json=b,timeout=70); secs=time.time()-t
            log(f"status={info.status} indexed={info.indexed_vectors_count:,} search={secs:.2f}s(http {r.status_code}) avail={avail()}MB")
            if info.status=="green" and r.status_code==200 and secs<2.0:
                log(f"CONVERGED — v2 search FAST ({secs:.2f}s), green. elapsed={(time.time()-t0)/60:.0f}min"); return 0
        except Exception as e:
            log(f"(busy: {type(e).__name__}) avail={avail()}MB")
        time.sleep(600)
    log("watcher timed out (8h)"); return 1

if __name__=="__main__":
    raise SystemExit(main())
