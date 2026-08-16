#!/usr/bin/env python3
"""Create / finalize the OCR corpus Qdrant collection (mandumah_ocr_v1).

Matches the LIVE mandumah_v2 config exactly (verified against the running
server, NOT the stale COLLECTION_CONFIG in ingest.py):
    dense   : 1536-d Cosine, on_disk
    sparse  : IDF modifier, on_disk
    quant   : BINARY, always_ram=True      <- v2 uses binary, not scalar
    hnsw    : m=16, ef_construct=100, on_disk

For a large one-shot bulk load we create with **HNSW m=0 (indexing disabled)**
so upserts don't pay per-batch graph construction — the slow part on the 1.7.4
optimizer. After the bulk load, run `finalize` to PATCH m=16, which builds the
graph in a single background pass.

Usage:
    python -m backend.pipeline.create_ocr_collection create   [--name ...] [--m 0]
    python -m backend.pipeline.create_ocr_collection finalize [--name ...] [--m 16]
    python -m backend.pipeline.create_ocr_collection status   [--name ...]
    python -m backend.pipeline.create_ocr_collection drop     --name <tmp>  --yes
"""
from __future__ import annotations

import argparse
import sys

DENSE_DIM = 1536
# Match the LIVE v2 per-vector dense HNSW exactly: ef_construct=256, graph in
# RAM (on_disk=False). This overrides the collection-level hnsw (ef=100).
EF_CONSTRUCT = 256
DENSE_HNSW_ON_DISK = False
DEFAULT_NAME = "mandumah_ocr_v1"

# Payload indexes: the ingest.py set plus `source` for federated provenance.
PAYLOAD_INDEXES = [
    ("doc_id", "keyword"),
    ("journal_id", "keyword"),
    ("section", "keyword"),
    ("title", "text"),
    ("journal", "keyword"),
    ("authors", "keyword"),
    ("year", "keyword"),
    ("source", "keyword"),
]


def _client(url: str):
    from qdrant_client import QdrantClient
    return QdrantClient(url=url, timeout=120)


def cmd_create(client, name: str, m: int):
    from qdrant_client import models

    existing = [c.name for c in client.get_collections().collections]
    if name in existing:
        print(f"Collection '{name}' already exists — not recreating.")
        return

    print(f"Creating '{name}' (dense {DENSE_DIM} Cosine, binary quant, hnsw m={m} "
          f"{'[indexing OFF for bulk load]' if m == 0 else ''})")
    client.create_collection(
        collection_name=name,
        vectors_config={
            "dense": models.VectorParams(
                size=DENSE_DIM,
                distance=models.Distance.COSINE,
                on_disk=True,
                hnsw_config=models.HnswConfigDiff(
                    m=m,                       # 0 = no graph (bulk-load mode)
                    ef_construct=EF_CONSTRUCT,
                    on_disk=DENSE_HNSW_ON_DISK,
                ),
            ),
        },
        sparse_vectors_config={
            "sparse": models.SparseVectorParams(
                modifier=models.Modifier.IDF,
                index=models.SparseIndexParams(on_disk=True),
            ),
        },
        hnsw_config=models.HnswConfigDiff(on_disk=True),
        quantization_config=models.BinaryQuantization(
            binary=models.BinaryQuantizationConfig(always_ram=True),
        ),
    )

    schema_map = {
        "keyword": models.PayloadSchemaType.KEYWORD,
        "text": models.PayloadSchemaType.TEXT,
    }
    for field, kind in PAYLOAD_INDEXES:
        client.create_payload_index(name, field_name=field, field_schema=schema_map[kind])
        print(f"  payload index: {field} ({kind})")
    print("done.")


def cmd_finalize(client, name: str, m: int, graph_on_disk: bool = True):
    """Enable HNSW indexing (m>0) so the graph builds in one pass.

    graph_on_disk=True (default) stores the HNSW links on disk (memmap) instead
    of RAM. This box runs v2's ~34GB in-RAM index + the RAG workers (~74% of
    64GB, swap already active), so building ocr_v1's graph in RAM risks OOM/swap
    thrash. On-disk trades a little search latency for the RAM headroom. Pass
    --graph-in-ram to match v2's in-RAM graph instead (only if RAM frees up).
    """
    from qdrant_client import models

    where = "on disk" if graph_on_disk else "in RAM"
    print(f"Enabling HNSW indexing on '{name}': dense hnsw m -> {m}, graph {where}")
    client.update_collection(
        collection_name=name,
        vectors_config={
            "dense": models.VectorParamsDiff(
                hnsw_config=models.HnswConfigDiff(m=m, on_disk=graph_on_disk),
            ),
        },
    )
    print("Index build requested. Watch status until 'green' (RAM-safe on disk):")
    cmd_status(client, name)


def cmd_status(client, name: str):
    info = client.get_collection(name)
    cfg = info.config
    vec = cfg.params.vectors
    dense = vec["dense"] if isinstance(vec, dict) else vec
    print(f"collection : {name}")
    print(f"status     : {info.status}")
    print(f"points     : {info.points_count}")
    print(f"segments   : {info.segments_count}")
    print(f"dense      : size={dense.size} distance={dense.distance} on_disk={dense.on_disk} "
          f"hnsw_m={getattr(dense.hnsw_config, 'm', None)}")
    print(f"quant      : {cfg.quantization_config}")


def cmd_drop(client, name: str, yes: bool):
    if not yes:
        print("Refusing to drop without --yes")
        sys.exit(1)
    client.delete_collection(name)
    print(f"dropped '{name}'")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("command", choices=["create", "finalize", "status", "drop"])
    ap.add_argument("--name", default=DEFAULT_NAME)
    ap.add_argument("--qdrant-url", default="http://localhost:6333")
    ap.add_argument("--m", type=int, default=None,
                    help="HNSW m (create default 0=bulk; finalize default 16)")
    ap.add_argument("--yes", action="store_true", help="confirm destructive drop")
    ap.add_argument("--graph-in-ram", action="store_true",
                    help="finalize: build HNSW graph in RAM (default: on disk, RAM-safe)")
    args = ap.parse_args()

    client = _client(args.qdrant_url)
    if args.command == "create":
        cmd_create(client, args.name, args.m if args.m is not None else 0)
    elif args.command == "finalize":
        cmd_finalize(client, args.name, args.m if args.m is not None else 16,
                     graph_on_disk=not args.graph_in_ram)
    elif args.command == "status":
        cmd_status(client, args.name)
    elif args.command == "drop":
        cmd_drop(client, args.name, args.yes)


if __name__ == "__main__":
    main()
