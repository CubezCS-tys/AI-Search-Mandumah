#!/usr/bin/env python3
"""Reconfigure mandumah_v2 to BINARY quantization and rebuild, then poll to completion.

Binary quant = ~2.3GB (1 bit/dim over 1536 dims x 11.7M pts) kept in RAM (always_ram=True),
so it fits in page cache easily and search stops full-scanning 18GB of int8 off disk.
Rescoring against on-disk originals keeps ranking quality. Safe now that v1 is parked
(16GB+ headroom); threads capped + memory watched so it can't thrash.
"""
import time, requests
from qdrant_client import QdrantClient, models

URL="http://localhost:6333"; COLL="mandumah_v2"

def avail(): return int(open("/proc/meminfo").read().split("MemAvailable:")[1].split()[0])//1024
def log(m): print(f"{time.strftime('%H:%M:%S')} {m}", flush=True)

def search_secs(c, seed):
    b={"vector":{"name":"dense","vector":seed.vector["dense"]},"limit":5}
    t=time.time()
    try:
        r=requests.post(f"{URL}/collections/{COLL}/points/search",json=b,timeout=70)
        return time.time()-t, r.status_code
    except Exception:
        return time.time()-t, 0

def main():
    c=QdrantClient(url=URL,timeout=300,check_compatibility=False)
    seed=c.scroll(COLL,limit=1,with_vectors=True)[0][0]
    log(f"applying BINARY quantization + rebuild (indexing_threshold=20000, 2 threads). avail={avail()}MB")
    c.update_collection(COLL,
        quantization_config=models.BinaryQuantization(
            binary=models.BinaryQuantizationConfig(always_ram=True)),
        optimizer_config=models.OptimizersConfigDiff(indexing_threshold=20000, max_optimization_threads=2))
    log("config applied; optimizer rebuilding. polling (search latency = ground truth)...")
    t0=time.time(); minavail=avail()
    while time.time()-t0 < 3*3600:
        minavail=min(minavail, avail())
        try:
            info=c.get_collection(COLL); secs,code=search_secs(c,seed)
            log(f"status={info.status} indexed={info.indexed_vectors_count:,} search={secs:.2f}s(http {code}) avail={avail()}MB min={minavail}MB")
            if info.status=="green" and code==200 and secs<2.0:
                log(f"BINARY REBUILD DONE in {(time.time()-t0)/60:.0f}min. search={secs:.2f}s min_avail_seen={minavail}MB")
                return 0
        except Exception as e:
            log(f"(busy: {type(e).__name__}) avail={avail()}MB")
        time.sleep(60)
    log("timed out"); return 1

if __name__=="__main__":
    raise SystemExit(main())
