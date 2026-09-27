#!/usr/bin/env python3
"""Rebuild ingest checkpoint from Qdrant's authoritative distinct doc_id set.

Full-scrolls every point in mandumah_v2 collecting distinct doc_id payloads,
then writes a valid ingest_checkpoint.json (processed list) to a *.rebuilt file.
Does NOT overwrite the live checkpoint.
"""
import json, time, urllib.request, sys
from pathlib import Path

URL = "http://localhost:6333/collections/mandumah_v2/points/scroll"
HERE = Path(__file__).resolve().parent
OUT = HERE / "ingest_checkpoint.json.rebuilt"
PROGRESS = HERE / "rebuild_checkpoint.progress"
PAGE = 20000


def scroll(offset):
    body = {"limit": PAGE, "with_payload": ["doc_id"], "with_vector": False}
    if offset is not None:
        body["offset"] = offset
    req = urllib.request.Request(
        URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
    )
    r = json.load(urllib.request.urlopen(req, timeout=120))["result"]
    return r["points"], r.get("next_page_offset")


def main():
    seen = set()
    scanned = 0
    offset = None
    t0 = time.time()
    while True:
        for attempt in range(5):
            try:
                pts, offset = scroll(offset)
                break
            except Exception as e:
                if attempt == 4:
                    raise
                time.sleep(2 * (attempt + 1))
        if not pts:
            break
        for p in pts:
            did = p["payload"].get("doc_id")
            if did is not None:
                seen.add(did)
        scanned += len(pts)
        PROGRESS.write_text(
            f"scanned={scanned} distinct={len(seen)} elapsed={time.time()-t0:.0f}s\n"
        )
        if offset is None:
            break

    checkpoint = {"processed": sorted(seen), "failed": [], "stats": {
        "rebuilt_from_qdrant": True,
        "rebuilt_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "points_scanned": scanned,
        "distinct_docs": len(seen),
    }}
    tmp = OUT.with_suffix(".rebuilt.tmp")
    with open(tmp, "w") as f:
        json.dump(checkpoint, f, indent=2)
    tmp.replace(OUT)
    PROGRESS.write_text(
        f"DONE scanned={scanned} distinct={len(seen)} elapsed={time.time()-t0:.0f}s\n"
    )
    print(f"DONE: scanned={scanned} distinct_docs={len(seen)} -> {OUT}")


if __name__ == "__main__":
    main()
