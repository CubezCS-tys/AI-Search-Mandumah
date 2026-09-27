#!/usr/bin/env python3
"""Create the clean, disk-backed target collection `mandumah_v2`.

Schema is identical to `mandumah_v1` (see backend/pipeline/ingest.py:create_collection):
dense "dense" 1536d Cosine on_disk + HNSW m16/ef256 on_disk, sparse "sparse" IDF on_disk,
int8 scalar quantization always_ram=False, on_disk_payload.

Two deliberate differences for a low-RAM bulk rebuild on this 31GB box:
  * optimizers.memmap_threshold = 20000  -> segments memory-map from disk (the whole point;
    this is what stops Qdrant holding the working set in anonymous RAM and OOM-ing).
  * optimizers.indexing_threshold = 0    -> HNSW indexing DISABLED during the bulk copy
    (Qdrant's documented bulk-upload mode: faster, lower RAM). Re-enabled to 20000 after the
    copy so the index builds in a single pass. Payload indexes are also created AFTER the copy.

Idempotent-ish: refuses to clobber an existing mandumah_v2 unless --force.
"""
import argparse
import sys

from qdrant_client import QdrantClient, models

TARGET = "mandumah_v2"
DENSE_DIM = 1536


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--qdrant-url", default="http://localhost:6333")
    ap.add_argument("--name", default=TARGET)
    ap.add_argument("--force", action="store_true", help="delete existing target first")
    args = ap.parse_args()

    client = QdrantClient(url=args.qdrant_url, timeout=120)
    existing = [c.name for c in client.get_collections().collections]
    if args.name in existing:
        if not args.force:
            print(f"ERROR: '{args.name}' already exists. Use --force to recreate.", file=sys.stderr)
            return 1
        print(f"Deleting existing '{args.name}' ...")
        client.delete_collection(args.name)

    print(f"Creating '{args.name}' (dim={DENSE_DIM}, on-disk, memmap_threshold=20000, indexing_threshold=0) ...")
    client.create_collection(
        collection_name=args.name,
        vectors_config={
            "dense": models.VectorParams(
                size=DENSE_DIM,
                distance=models.Distance.COSINE,
                on_disk=True,
                hnsw_config=models.HnswConfigDiff(m=16, ef_construct=256, on_disk=True),
            ),
        },
        sparse_vectors_config={
            "sparse": models.SparseVectorParams(
                modifier=models.Modifier.IDF,
                index=models.SparseIndexParams(on_disk=True),
            ),
        },
        hnsw_config=models.HnswConfigDiff(on_disk=True),
        quantization_config=models.ScalarQuantization(
            scalar=models.ScalarQuantizationConfig(
                type=models.ScalarType.INT8, quantile=0.99, always_ram=False,
            ),
        ),
        on_disk_payload=True,
        optimizers_config=models.OptimizersConfigDiff(
            memmap_threshold=20000,
            indexing_threshold=0,       # disable HNSW build during bulk copy
            max_optimization_threads=1,
        ),
    )
    info = client.get_collection(args.name)
    oc = info.config.optimizer_config
    print(f"Created '{args.name}': status={info.status} "
          f"memmap_threshold={oc.memmap_threshold} indexing_threshold={oc.indexing_threshold} "
          f"on_disk_payload={info.config.params.on_disk_payload}")
    print("NOTE: payload indexes and HNSW indexing are intentionally deferred until after the copy.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
