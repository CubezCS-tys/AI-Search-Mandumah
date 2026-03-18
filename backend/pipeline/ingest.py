"""
Document ingestion pipeline with pipelined parallelism.

Reads OCR JSON files → chunks them → embeds with BGE-M3 → upserts to Qdrant.

Architecture:
    [Chunker Thread] --queue--> [Embedder Thread] --queue--> [Upserter Thread]

    Stage 1 (Chunker):  Reads JSON, chunks documents, batches them
    Stage 2 (Embedder): Encodes batches with BGE-M3 (dense + sparse)
    Stage 3 (Upserter): Upserts points to Qdrant, updates checkpoint

All three stages run concurrently so chunking and network I/O overlap
with the GPU-bound embedding stage.

Usage:
    python -m pipeline.ingest --input-dir output/ --collection academic_articles

Supports:
    - Resume from checkpoint (tracks processed doc IDs)
    - Pipelined parallel processing
    - Dry-run mode for testing
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import queue
import threading
import time
from pathlib import Path

from backend.pipeline.chunker import Chunk, chunk_document

logger = logging.getLogger(__name__)

# Qdrant collection configuration
COLLECTION_CONFIG = {
    "dense_dim": 1024,       # BGE-M3 dense vector dimensions
    "distance": "Cosine",
    "on_disk": True,         # Store original vectors on disk
    "hnsw_m": 16,
    "hnsw_ef_construct": 256,
    "quantization": "scalar", # INT8 scalar quantization
}

CHECKPOINT_FILE = "ingest_checkpoint.json"

# Sentinel value to signal end of a pipeline stage
_SENTINEL = None


def _make_point_id(chunk_id: str) -> str:
    """Generate a deterministic UUID-like ID from chunk_id."""
    return hashlib.md5(chunk_id.encode()).hexdigest()


def _find_json_files(input_dir: Path) -> list[Path]:
    """Find all article JSON files in the output directory structure."""
    files = []
    for journal_dir in sorted(input_dir.iterdir()):
        if not journal_dir.is_dir() or journal_dir.name.startswith("."):
            continue
        for article_dir in sorted(journal_dir.iterdir()):
            if not article_dir.is_dir():
                continue
            json_file = article_dir / f"{article_dir.name}.json"
            if json_file.exists() and not json_file.name.endswith("Zone.Identifier"):
                files.append(json_file)
    return files


def _load_checkpoint(checkpoint_path: Path) -> dict:
    if checkpoint_path.exists():
        with open(checkpoint_path) as f:
            return json.load(f)
    return {"processed": [], "failed": [], "stats": {}}


def _save_checkpoint(checkpoint_path: Path, checkpoint: dict):
    with open(checkpoint_path, "w") as f:
        json.dump(checkpoint, f, indent=2)


def _extract_metadata_from_path(json_path: Path) -> dict:
    """Extract journal/volume/issue/article metadata from the file path and ID."""
    doc_id = json_path.stem  # e.g. "0005-075-001-002"
    parts = doc_id.split("-")
    meta = {"doc_id": doc_id}
    if len(parts) == 4:
        meta["journal_id"] = parts[0]
        meta["volume"] = parts[1]
        meta["issue"] = parts[2]
        meta["article_num"] = parts[3]
    return meta


def create_collection(client, collection_name: str):
    """Create Qdrant collection with hybrid search configuration."""
    from qdrant_client import models

    collections = [c.name for c in client.get_collections().collections]
    if collection_name in collections:
        logger.info("Collection '%s' already exists", collection_name)
        return

    logger.info("Creating collection '%s'", collection_name)
    client.create_collection(
        collection_name=collection_name,
        vectors_config={
            "dense": models.VectorParams(
                size=COLLECTION_CONFIG["dense_dim"],
                distance=models.Distance.COSINE,
                on_disk=True,
                hnsw_config=models.HnswConfigDiff(
                    m=COLLECTION_CONFIG["hnsw_m"],
                    ef_construct=COLLECTION_CONFIG["hnsw_ef_construct"],
                    on_disk=True,
                ),
            ),
        },
        sparse_vectors_config={
            "sparse": models.SparseVectorParams(
                modifier=models.Modifier.IDF,
            ),
        },
        quantization_config=models.ScalarQuantization(
            scalar=models.ScalarQuantizationConfig(
                type=models.ScalarType.INT8,
                quantile=0.99,
                always_ram=False,
            ),
        ),
    )

    # Create payload indexes for filtering
    for field, schema in [
        ("doc_id", models.PayloadSchemaType.KEYWORD),
        ("journal_id", models.PayloadSchemaType.KEYWORD),
        ("section", models.PayloadSchemaType.KEYWORD),
        ("title", models.PayloadSchemaType.TEXT),
    ]:
        client.create_payload_index(
            collection_name=collection_name,
            field_name=field,
            field_schema=schema,
        )
    logger.info("Collection '%s' created with indexes", collection_name)


def _build_payload(chunk: Chunk, doc_meta: dict, title: str) -> dict:
    """Build the Qdrant point payload."""
    return {
        "chunk_id": chunk.chunk_id,
        "doc_id": chunk.doc_id,
        "text": chunk.text,
        "title": title,
        "section": chunk.section,
        "char_len": chunk.char_len,
        "chunk_index": chunk.chunk_index,
        **{k: v for k, v in doc_meta.items() if k != "doc_id"},
    }


# ── Pipeline stage 1: Chunker ────────────────────────────────────────────


def _chunk_worker(
    remaining: list[Path],
    batch_size: int,
    embed_queue: queue.Queue,
    progress: dict,
    cancel: threading.Event,
):
    """Read JSON files, chunk documents, and produce batches for embedding."""
    batch_chunks: list[Chunk] = []
    batch_payloads: list[dict] = []
    batch_doc_ids: list[str] = []

    try:
        for json_path in remaining:
            if cancel.is_set():
                break

            doc_id = json_path.stem
            progress["current_doc"] = doc_id

            try:
                with open(json_path) as f:
                    data = json.load(f)

                content = data.get("content", "")
                if not content or len(content.strip()) < 100:
                    logger.warning("Skipping %s: content too short", doc_id)
                    progress["failed"].append(doc_id)
                    continue

                result = chunk_document(content, doc_id)
                doc_meta = _extract_metadata_from_path(json_path)

                if not result.chunks:
                    logger.warning("Skipping %s: no chunks produced", doc_id)
                    progress["failed"].append(doc_id)
                    continue

                for chunk in result.chunks:
                    batch_chunks.append(chunk)
                    batch_payloads.append(
                        _build_payload(chunk, doc_meta, result.title)
                    )
                batch_doc_ids.append(doc_id)

                # Send batch when full
                if len(batch_chunks) >= batch_size:
                    embed_queue.put((
                        list(batch_chunks),
                        list(batch_payloads),
                        list(batch_doc_ids),
                    ))
                    batch_chunks.clear()
                    batch_payloads.clear()
                    batch_doc_ids.clear()

            except Exception as e:
                logger.error("Chunking failed for %s: %s", doc_id, e, exc_info=True)
                progress["failed"].append(doc_id)

        # Flush remaining
        if batch_chunks and not cancel.is_set():
            embed_queue.put((
                list(batch_chunks),
                list(batch_payloads),
                list(batch_doc_ids),
            ))
    finally:
        embed_queue.put(_SENTINEL)


# ── Pipeline stage 2: Embedder ───────────────────────────────────────────


def _embed_worker(
    embedder,
    embed_queue: queue.Queue,
    upsert_queue: queue.Queue,
    dry_run: bool,
    cancel: threading.Event,
):
    """Pull chunk batches, encode with BGE-M3, and produce point batches."""
    from qdrant_client import models

    try:
        while not cancel.is_set():
            item = embed_queue.get()
            if item is _SENTINEL:
                break

            chunks, payloads, doc_ids = item
            texts = [c.embed_text for c in chunks]
            embeddings = embedder.encode(texts)

            if dry_run:
                logger.info("DRY RUN: embedded %d chunks, skipping upsert", len(chunks))
                upsert_queue.put((None, doc_ids, len(chunks)))
                continue

            points = []
            for chunk, payload, emb in zip(chunks, payloads, embeddings):
                point_id = _make_point_id(chunk.chunk_id)
                points.append(models.PointStruct(
                    id=point_id,
                    vector={
                        "dense": emb.dense,
                        "sparse": models.SparseVector(
                            indices=emb.sparse_indices,
                            values=emb.sparse_values,
                        ),
                    },
                    payload=payload,
                ))

            upsert_queue.put((points, doc_ids, len(chunks)))
    finally:
        upsert_queue.put(_SENTINEL)


# ── Pipeline stage 3: Upserter ───────────────────────────────────────────


def _upsert_worker(
    client,
    collection_name: str,
    upsert_queue: queue.Queue,
    checkpoint: dict,
    checkpoint_path: Path,
    progress: dict,
    cancel: threading.Event,
):
    """Pull embedded point batches, upsert to Qdrant, and update checkpoint."""
    upsert_count = 0

    while not cancel.is_set():
        item = upsert_queue.get()
        if item is _SENTINEL:
            break

        points, doc_ids, num_chunks = item

        # Upsert in sub-batches of 100
        if points is not None:
            for j in range(0, len(points), 100):
                client.upsert(
                    collection_name=collection_name,
                    points=points[j : j + 100],
                )

        # Mark docs as processed
        for did in doc_ids:
            checkpoint["processed"].append(did)
        progress["processed_docs"] += len(doc_ids)
        progress["total_chunks"] += num_chunks

        # Save checkpoint periodically
        upsert_count += 1
        if upsert_count % 5 == 0:
            _save_checkpoint(checkpoint_path, checkpoint)

    # Final checkpoint save
    _save_checkpoint(checkpoint_path, checkpoint)


# ── Orchestrator ──────────────────────────────────────────────────────────


def ingest_documents(
    input_dir: str,
    collection_name: str = "academic_articles",
    qdrant_url: str = "http://localhost:6333",
    batch_size: int = 32,
    dry_run: bool = False,
    resume: bool = True,
    limit: int = 0,
):
    """
    Main ingestion pipeline with pipelined parallelism.

    Three stages run concurrently:
        Chunker (CPU/IO) → Embedder (GPU) → Upserter (network IO)

    Args:
        input_dir: Path to the output/ directory with OCR results.
        collection_name: Qdrant collection name.
        qdrant_url: Qdrant server URL.
        batch_size: Embedding batch size.
        dry_run: If True, chunk and embed but don't write to Qdrant.
        resume: If True, skip already-processed documents.
        limit: Max number of documents to process (0 = all).
    """
    from backend.pipeline.embedder import BGEm3Embedder

    input_path = Path(input_dir)
    checkpoint_path = input_path / CHECKPOINT_FILE

    # Find all JSON files
    json_files = _find_json_files(input_path)
    logger.info("Found %d JSON files in %s", len(json_files), input_dir)

    if not json_files:
        logger.warning("No JSON files found!")
        return

    # Load checkpoint
    checkpoint = (
        _load_checkpoint(checkpoint_path)
        if resume
        else {"processed": [], "failed": [], "stats": {}}
    )
    processed_ids = set(checkpoint["processed"])
    remaining = [f for f in json_files if f.stem not in processed_ids]
    if limit > 0:
        remaining = remaining[:limit]
    logger.info("Already processed: %d, Remaining: %d", len(processed_ids), len(remaining))

    if not remaining:
        logger.info("All documents already processed!")
        return

    # Initialize embedder (lazy-loads model on first encode call)
    embedder = BGEm3Embedder(batch_size=batch_size)

    # Initialize Qdrant
    client = None
    if not dry_run:
        from qdrant_client import QdrantClient

        client = QdrantClient(url=qdrant_url, timeout=120)
        create_collection(client, collection_name)

    # Shared progress state (written by workers, read by main thread)
    progress = {
        "processed_docs": 0,
        "total_chunks": 0,
        "current_doc": "",
        "failed": [],
    }
    cancel = threading.Event()

    # Queues between stages (bounded to limit memory usage)
    embed_queue: queue.Queue = queue.Queue(maxsize=4)
    upsert_queue: queue.Queue = queue.Queue(maxsize=4)

    start_time = time.time()

    # Launch pipeline stages
    t_chunk = threading.Thread(
        target=_chunk_worker,
        args=(remaining, batch_size, embed_queue, progress, cancel),
        name="chunker",
        daemon=True,
    )
    t_embed = threading.Thread(
        target=_embed_worker,
        args=(embedder, embed_queue, upsert_queue, dry_run, cancel),
        name="embedder",
        daemon=True,
    )
    t_upsert = threading.Thread(
        target=_upsert_worker,
        args=(client, collection_name, upsert_queue, checkpoint, checkpoint_path, progress, cancel),
        name="upserter",
        daemon=True,
    )

    t_chunk.start()
    t_embed.start()
    t_upsert.start()

    logger.info(
        "Pipeline started: %d docs to process (chunker → embedder → upserter)",
        len(remaining),
    )

    # Monitor progress until the upserter finishes
    try:
        while t_upsert.is_alive():
            t_upsert.join(timeout=10)
            elapsed = time.time() - start_time
            rate = progress["total_chunks"] / elapsed if elapsed > 0 else 0
            logger.info(
                "Progress: %d/%d docs | %d chunks | %.1f chunks/sec | current: %s",
                progress["processed_docs"],
                len(remaining),
                progress["total_chunks"],
                rate,
                progress["current_doc"],
            )
    except KeyboardInterrupt:
        logger.warning("Interrupted — signalling workers to stop...")
        cancel.set()
        t_chunk.join(timeout=5)
        t_embed.join(timeout=10)
        t_upsert.join(timeout=10)

    # Wait for all threads to finish
    t_chunk.join()
    t_embed.join()
    t_upsert.join()

    # Merge failed lists
    checkpoint["failed"] = list(set(checkpoint.get("failed", []) + progress["failed"]))

    # Save final stats
    elapsed = time.time() - start_time
    total_chunks = progress["total_chunks"]
    checkpoint["stats"] = {
        "total_docs": len(checkpoint["processed"]),
        "total_chunks": total_chunks,
        "failed_docs": len(checkpoint["failed"]),
        "elapsed_seconds": round(elapsed, 1),
    }
    _save_checkpoint(checkpoint_path, checkpoint)

    logger.info(
        "Ingestion complete: %d docs, %d chunks in %.1fs (%.1f chunks/sec)",
        progress["processed_docs"],
        total_chunks,
        elapsed,
        total_chunks / elapsed if elapsed > 0 else 0,
    )
    if progress["failed"]:
        logger.warning("Failed documents (%d): %s", len(progress["failed"]), progress["failed"][:10])


def main():
    parser = argparse.ArgumentParser(description="Ingest OCR documents into Qdrant")
    parser.add_argument("--input-dir", required=True, help="Path to output/ directory")
    parser.add_argument("--collection", default="academic_articles", help="Qdrant collection name")
    parser.add_argument("--qdrant-url", default="http://localhost:6333", help="Qdrant server URL")
    parser.add_argument("--batch-size", type=int, default=32, help="Embedding batch size")
    parser.add_argument("--limit", type=int, default=0, help="Max documents to process (0 = all)")
    parser.add_argument("--dry-run", action="store_true", help="Chunk and embed without writing to Qdrant")
    parser.add_argument("--no-resume", action="store_true", help="Start fresh, ignore checkpoint")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose logging")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    ingest_documents(
        input_dir=args.input_dir,
        collection_name=args.collection,
        qdrant_url=args.qdrant_url,
        batch_size=args.batch_size,
        dry_run=args.dry_run,
        resume=not args.no_resume,
        limit=args.limit,
    )


if __name__ == "__main__":
    main()
