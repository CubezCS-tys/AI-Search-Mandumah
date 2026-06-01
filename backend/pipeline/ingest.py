"""
Document ingestion pipeline with async OpenAI embeddings.

Reads OCR JSON files -> chunks them -> embeds with OpenAI -> upserts to Qdrant.

Architecture:
    [Chunker Thread] --queue--> [Embedder Thread (async)] --queue--> [Upserter Thread]

    Stage 1 (Chunker):  Reads JSON, chunks documents, batches them
    Stage 2 (Embedder): Encodes batches via async OpenAI API (concurrent requests)
    Stage 3 (Upserter): Upserts points to Qdrant, updates checkpoint

Features:
    - Async concurrent OpenAI embedding requests (semaphore + rate limiter)
    - Paragraph-level content deduplication (mmh3 hash)
    - File-level hash skip (SHA1 — skip unchanged files)
    - Graceful shutdown (SIGINT/SIGTERM -> emergency checkpoint)
    - Memory monitoring (psutil)
    - Dry-run mode (pre-scan stats, no API calls)
    - No-write mode (embed but skip Qdrant upsert)
    - Manifest JSON summarizing each run
    - ETA & throughput reporting (tqdm)
    - Dimension validation vs existing collection (--force-recreate to override)
    - Fully on-disk storage (vectors, HNSW index, quantization)

Usage:
    python -m backend.pipeline.ingest --input-dir output/ --collection academic_articles_v2
    python -m backend.pipeline.ingest --input-dir output/ --collection academic_articles_v2 --dry-run --limit 100
    python -m backend.pipeline.ingest --input-dir output/ --collection academic_articles_v2 --max-concurrent 8
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import logging
import os
import queue
import signal
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

from backend.pipeline.chunker import Chunk, chunk_document

load_dotenv()

logger = logging.getLogger(__name__)

# ── Qdrant collection configuration ─────────────────────────────────────

COLLECTION_CONFIG = {
    "dense_dim": 1536,       # OpenAI text-embedding-3-small
    "distance": "Cosine",
    "on_disk": True,         # Store original vectors on disk
    "hnsw_m": 16,
    "hnsw_ef_construct": 256,
    "quantization": "scalar", # INT8 scalar quantization
}

CHECKPOINT_FILE = "ingest_checkpoint.json"
PARA_HASH_FILE = "ingest_paragraph_hashes.json"
FILE_HASH_FILE = "ingest_file_hashes.json"
MANIFEST_FILE = "ingest_manifest.json"

CHECKPOINT_INTERVAL = 100    # Save checkpoint every N files
MEMORY_LIMIT_MB = 31_000     # Memory warning threshold

# Sentinel value to signal end of a pipeline stage
_SENTINEL = None


# ── Deduplication helpers ────────────────────────────────────────────────


def _make_point_id(chunk_id: str) -> str:
    """Generate a deterministic UUID-like ID from chunk_id."""
    return hashlib.md5(chunk_id.encode()).hexdigest()


def _paragraph_content_hash(text: str) -> str:
    """Stable 64-bit hash of first 1024 chars for content deduplication."""
    try:
        import mmh3
        return str(mmh3.hash64(text[:1024], signed=False)[0])
    except ImportError:
        return hashlib.sha256(text[:1024].encode()).hexdigest()[:16]


def _file_content_hash(path: Path) -> str:
    """SHA1 hash of file bytes for file-level skip."""
    try:
        return hashlib.sha1(path.read_bytes()).hexdigest()
    except Exception:
        return ""


# ── File discovery ───────────────────────────────────────────────────────


def _find_json_files(input_dir: Path) -> list[Path]:
    """Find all article JSON files in the output directory structure.

    Supports two layouts:
      - Nested (output/):       input_dir/journal_group/article_id/article_id.json
      - Flat   (output_batch*): input_dir/article_id/article_id.json

    Auto-detects by checking whether first-level subdirectories contain
    a matching JSON file directly.
    """
    files = []

    subdirs = sorted(
        d for d in input_dir.iterdir()
        if d.is_dir() and not d.name.startswith(".")
    )
    if not subdirs:
        return files

    # Detect layout: if the first subdir contains a matching JSON, it's flat
    sample = subdirs[0]
    is_flat = (sample / f"{sample.name}.json").exists()

    if is_flat:
        # Flat: input_dir/article_id/article_id.json
        for article_dir in subdirs:
            json_file = article_dir / f"{article_dir.name}.json"
            if json_file.exists() and not json_file.name.endswith("Zone.Identifier"):
                files.append(json_file)
    else:
        # Nested: input_dir/journal_group/article_id/article_id.json
        for journal_dir in subdirs:
            for article_dir in sorted(journal_dir.iterdir()):
                if not article_dir.is_dir():
                    continue
                json_file = article_dir / f"{article_dir.name}.json"
                if json_file.exists() and not json_file.name.endswith("Zone.Identifier"):
                    files.append(json_file)

    return files


# ── Checkpoint & state ───────────────────────────────────────────────────


def _load_checkpoint(checkpoint_path: Path) -> dict:
    if checkpoint_path.exists():
        with open(checkpoint_path) as f:
            return json.load(f)
    return {"processed": [], "failed": [], "stats": {}}


def _save_checkpoint(checkpoint_path: Path, checkpoint: dict):
    with open(checkpoint_path, "w") as f:
        json.dump(checkpoint, f, indent=2)


def _load_para_hashes(path: Path) -> set[str]:
    if path.exists():
        try:
            return set(json.loads(path.read_text()))
        except Exception:
            pass
    return set()


def _save_para_hashes(path: Path, hashes: set[str]):
    path.write_text(json.dumps(sorted(hashes), indent=2))


def _load_file_hashes(path: Path) -> dict[str, str]:
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            pass
    return {}


def _save_file_hashes(path: Path, hashes: dict[str, str]):
    path.write_text(json.dumps(hashes, indent=2))


def _write_manifest(path: Path, data: dict):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False))


# ── Metadata extraction ─────────────────────────────────────────────────


def _extract_metadata_from_path(json_path: Path) -> dict:
    """Extract journal/volume/issue/article metadata from the file path and ID."""
    doc_id = json_path.stem
    parts = doc_id.split("-")
    meta = {"doc_id": doc_id}
    if len(parts) == 4:
        meta["journal_id"] = parts[0]
        meta["volume"] = parts[1]
        meta["issue"] = parts[2]
        meta["article_num"] = parts[3]
    return meta


# ── Collection management ───────────────────────────────────────────────


def create_collection(client, collection_name: str, force_recreate: bool = False):
    """Create Qdrant collection with hybrid search configuration.

    All vectors, HNSW index, and quantization are stored on disk.
    Validates dimension against existing collection; use force_recreate to override.
    """
    from qdrant_client import models

    collections = [c.name for c in client.get_collections().collections]

    if collection_name in collections:
        if force_recreate:
            logger.warning("Force-recreating collection '%s'", collection_name)
            client.delete_collection(collection_name)
        else:
            # Validate dimension
            info = client.get_collection(collection_name)
            existing_config = info.config.params.vectors
            if hasattr(existing_config, "get"):
                existing_dim = existing_config["dense"].size
            else:
                existing_dim = existing_config.size if hasattr(existing_config, "size") else None

            if existing_dim and existing_dim != COLLECTION_CONFIG["dense_dim"]:
                logger.error(
                    "Dimension mismatch: existing=%d, expected=%d. Use --force-recreate to override.",
                    existing_dim,
                    COLLECTION_CONFIG["dense_dim"],
                )
                sys.exit(1)

            logger.info("Collection '%s' already exists (dim=%s)", collection_name, existing_dim)
            return

    logger.info("Creating collection '%s' (dim=%d, fully on-disk)", collection_name, COLLECTION_CONFIG["dense_dim"])
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
        hnsw_config=models.HnswConfigDiff(on_disk=True),
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


# ── Memory monitoring ───────────────────────────────────────────────────


def _check_memory():
    """Check memory usage and force cleanup if needed."""
    try:
        import psutil
        mem_mb = psutil.Process().memory_info().rss / 1024 / 1024
        if mem_mb > MEMORY_LIMIT_MB:
            logger.warning("High memory usage: %.0fMB. Forcing cleanup...", mem_mb)
            gc.collect()
            new_mb = psutil.Process().memory_info().rss / 1024 / 1024
            logger.info("Freed %.0fMB (now %.0fMB)", mem_mb - new_mb, new_mb)
    except ImportError:
        pass


# ── Pipeline stage 1: Chunker ───────────────────────────────────────────


def _chunk_worker(
    remaining: list[Path],
    batch_size: int,
    embed_queue: queue.Queue,
    progress: dict,
    cancel: threading.Event,
    para_hashes: set[str],
    file_hashes: dict[str, str],
    para_hashes_lock: threading.Lock,
):
    """Read JSON files, chunk documents, and produce batches for embedding.

    Performs paragraph-level and file-level deduplication.
    """
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
                # File-level skip: if file content unchanged, skip entirely
                current_fhash = _file_content_hash(json_path)
                if current_fhash and json_path.name in file_hashes:
                    if file_hashes[json_path.name] == current_fhash:
                        progress["skipped_file_dup"] += 1
                        # Still mark as processed for checkpoint
                        batch_doc_ids.append(doc_id)
                        continue

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
                    # Paragraph-level dedup
                    phash = _paragraph_content_hash(chunk.text)
                    with para_hashes_lock:
                        if phash in para_hashes:
                            progress["skipped_para_dup"] += 1
                            continue
                        para_hashes.add(phash)

                    batch_chunks.append(chunk)
                    batch_payloads.append(
                        _build_payload(chunk, doc_meta, result.title)
                    )
                batch_doc_ids.append(doc_id)

                # Update file hash after successful chunking
                if current_fhash:
                    file_hashes[json_path.name] = current_fhash

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


# ── Pipeline stage 2: Embedder ──────────────────────────────────────────


def _embed_worker(
    embedder,
    embed_queue: queue.Queue,
    upsert_queue: queue.Queue,
    dry_run: bool,
    no_write: bool,
    cancel: threading.Event,
):
    """Pull chunk batches, encode with OpenAI (async), produce point batches."""
    from qdrant_client import models

    try:
        while not cancel.is_set():
            item = embed_queue.get()
            if item is _SENTINEL:
                break

            chunks, payloads, doc_ids = item
            texts = [c.embed_text for c in chunks]

            if dry_run:
                logger.info("DRY RUN: would embed %d chunks, skipping", len(chunks))
                upsert_queue.put((None, doc_ids, len(chunks)))
                continue

            embeddings = embedder.encode(texts)

            if no_write:
                logger.info("NO-WRITE: embedded %d chunks, skipping upsert", len(chunks))
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


# ── Pipeline stage 3: Upserter ──────────────────────────────────────────


def _upsert_worker(
    client,
    collection_name: str,
    upsert_queue: queue.Queue,
    checkpoint: dict,
    checkpoint_path: Path,
    progress: dict,
    cancel: threading.Event,
    checkpoint_lock: threading.Lock,
):
    """Pull embedded point batches, upsert to Qdrant, and update checkpoint."""
    upsert_count = 0
    processed_set = set(checkpoint["processed"])

    while not cancel.is_set():
        item = upsert_queue.get()
        if item is _SENTINEL:
            break

        points, doc_ids, num_chunks = item

        # Upsert in sub-batches of 200
        upsert_failed = False
        if points is not None:
            for j in range(0, len(points), 200):
                sub_ok = False
                for attempt in range(3):
                    try:
                        client.upsert(
                            collection_name=collection_name,
                            points=points[j : j + 200],
                        )
                        sub_ok = True
                        break
                    except Exception as e:
                        if attempt < 2:
                            wait = (2 ** attempt) * 2
                            logger.warning(
                                "Qdrant upsert error (attempt %d/3): %s — retrying in %ds",
                                attempt + 1, e, wait,
                            )
                            time.sleep(wait)
                        else:
                            logger.error("Qdrant upsert failed after 3 attempts: %s", e)
                if not sub_ok:
                    upsert_failed = True

        # Only mark docs as processed if all sub-batches succeeded
        with checkpoint_lock:
            if upsert_failed:
                for did in doc_ids:
                    if did not in checkpoint["failed"]:
                        checkpoint["failed"].append(did)
                logger.error("Docs moved to failed: %s", doc_ids)
            else:
                for did in doc_ids:
                    if did not in processed_set:
                        processed_set.add(did)
                        checkpoint["processed"].append(did)
            progress["processed_docs"] += len(doc_ids)
            progress["total_chunks"] += num_chunks

        # Save checkpoint periodically
        upsert_count += 1
        if upsert_count % 5 == 0:
            with checkpoint_lock:
                _save_checkpoint(checkpoint_path, checkpoint)
            _check_memory()

    # Final checkpoint save
    with checkpoint_lock:
        _save_checkpoint(checkpoint_path, checkpoint)


# ── Dry-run pre-scan ─────────────────────────────────────────────────────


def _dry_run_scan(
    remaining: list[Path],
    para_hashes: set[str],
    file_hashes: dict[str, str],
):
    """Pre-scan files to show dedup stats without calling the API."""
    total_files = len(remaining)
    unchanged_files = 0
    new_files = 0
    total_paras = 0
    dup_paras = 0
    seen = set(para_hashes)

    for fp in remaining:
        fh = _file_content_hash(fp)
        if fh and fp.name in file_hashes and file_hashes[fp.name] == fh:
            unchanged_files += 1
            continue

        try:
            with open(fp) as f:
                data = json.load(f)
            content = data.get("content", "")
            if not content or len(content.strip()) < 100:
                continue

            result = chunk_document(content, fp.stem)
            new_files += 1
            for chunk in result.chunks:
                total_paras += 1
                h = _paragraph_content_hash(chunk.text)
                if h in seen:
                    dup_paras += 1
                else:
                    seen.add(h)
        except Exception:
            continue

    unique = total_paras - dup_paras
    logger.info("DRY RUN Pre-scan Results:")
    logger.info("  Total files to scan:     %d", total_files)
    logger.info("  Unchanged (file skip):   %d", unchanged_files)
    logger.info("  New/changed files:       %d", new_files)
    logger.info("  Total paragraphs (raw):  %d", total_paras)
    logger.info("  Duplicate paragraphs:    %d", dup_paras)
    logger.info("  Unique new paragraphs:   %d", unique)
    logger.info("(No embeddings generated in dry run.)")


# ── Orchestrator ─────────────────────────────────────────────────────────


def ingest_documents(
    input_dir: str,
    collection_name: str = "academic_articles_v2",
    qdrant_url: str = "http://localhost:6333",
    batch_size: int = 100,
    max_concurrent: int = 10,
    dry_run: bool = False,
    no_write: bool = False,
    resume: bool = True,
    limit: int = 0,
    force_recreate: bool = False,
    normalize_arabic: bool = True,
):
    """
    Main ingestion pipeline with async OpenAI embeddings.

    Three stages run concurrently:
        Chunker (CPU/IO) -> Embedder (async OpenAI API) -> Upserter (Qdrant IO)

    Args:
        input_dir: Path to the output/ directory with OCR results.
        collection_name: Qdrant collection name.
        qdrant_url: Qdrant server URL.
        batch_size: Embedding batch size (texts per API call).
        max_concurrent: Max concurrent OpenAI API requests.
        dry_run: If True, pre-scan only — no API calls or writes.
        no_write: If True, embed but don't write to Qdrant.
        resume: If True, skip already-processed documents.
        limit: Max number of documents to process (0 = all).
        force_recreate: If True, drop and recreate Qdrant collection.
        normalize_arabic: Whether to normalize Arabic text.
    """
    from backend.pipeline.embedder import OpenAIEmbedder

    input_path = Path(input_dir)
    checkpoint_path = input_path / CHECKPOINT_FILE
    para_hash_path = input_path / PARA_HASH_FILE
    file_hash_path = input_path / FILE_HASH_FILE
    manifest_path = input_path / MANIFEST_FILE

    # Find all JSON files
    json_files = _find_json_files(input_path)
    logger.info("Found %d JSON files in %s", len(json_files), input_dir)

    if not json_files:
        logger.warning("No JSON files found!")
        return

    # Load checkpoint & dedup state
    checkpoint = (
        _load_checkpoint(checkpoint_path)
        if resume
        else {"processed": [], "failed": [], "stats": {}}
    )
    para_hashes = _load_para_hashes(para_hash_path) if resume else set()
    file_hashes = _load_file_hashes(file_hash_path) if resume else {}

    processed_ids = set(checkpoint["processed"])
    remaining = [f for f in json_files if f.stem not in processed_ids]
    if limit > 0:
        remaining = remaining[:limit]
    logger.info(
        "Already processed: %d, Remaining: %d, Paragraph hashes: %d, File hashes: %d",
        len(processed_ids), len(remaining), len(para_hashes), len(file_hashes),
    )

    if not remaining:
        logger.info("All documents already processed!")
        return

    # Dry-run: pre-scan only
    if dry_run:
        _dry_run_scan(remaining, para_hashes, file_hashes)
        return

    # Initialize embedder
    embedder = OpenAIEmbedder(batch_size=batch_size, max_concurrent=max_concurrent)

    # Initialize Qdrant
    client = None
    if not no_write:
        from qdrant_client import QdrantClient

        client = QdrantClient(url=qdrant_url, timeout=120)
        create_collection(client, collection_name, force_recreate=force_recreate)

    # Shared progress state
    progress = {
        "processed_docs": 0,
        "total_chunks": 0,
        "current_doc": "",
        "failed": [],
        "skipped_file_dup": 0,
        "skipped_para_dup": 0,
    }
    cancel = threading.Event()
    para_hashes_lock = threading.Lock()
    checkpoint_lock = threading.Lock()

    # Graceful shutdown handler
    def _signal_handler(signum, frame):
        logger.warning("Received signal %d — initiating graceful shutdown...", signum)
        cancel.set()
        # Emergency checkpoint
        try:
            with checkpoint_lock:
                _save_checkpoint(checkpoint_path, checkpoint)
            _save_para_hashes(para_hash_path, para_hashes)
            _save_file_hashes(file_hash_path, file_hashes)
            logger.info("Emergency checkpoint saved!")
        except Exception as e:
            logger.error("Failed to save emergency checkpoint: %s", e)

    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    # Queues between stages (bounded to limit memory usage)
    embed_queue: queue.Queue = queue.Queue(maxsize=4)
    upsert_queue: queue.Queue = queue.Queue(maxsize=4)

    start_time = time.time()

    # Launch pipeline stages
    t_chunk = threading.Thread(
        target=_chunk_worker,
        args=(remaining, batch_size, embed_queue, progress, cancel,
              para_hashes, file_hashes, para_hashes_lock),
        name="chunker",
        daemon=True,
    )
    t_embed = threading.Thread(
        target=_embed_worker,
        args=(embedder, embed_queue, upsert_queue, dry_run, no_write, cancel),
        name="embedder",
        daemon=True,
    )
    t_upsert = threading.Thread(
        target=_upsert_worker,
        args=(client, collection_name, upsert_queue, checkpoint,
              checkpoint_path, progress, cancel, checkpoint_lock),
        name="upserter",
        daemon=True,
    )

    t_chunk.start()
    t_embed.start()
    t_upsert.start()

    logger.info(
        "Pipeline started: %d docs to process (chunker -> embedder[async x%d] -> upserter)",
        len(remaining),
        max_concurrent,
    )

    # Monitor progress with tqdm
    try:
        from tqdm import tqdm

        pbar = tqdm(
            total=len(remaining),
            desc="Ingesting",
            unit="doc",
            ncols=120,
            bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt} [{elapsed}, {rate_fmt}] {postfix}",
        )
    except ImportError:
        pbar = None

    try:
        last_doc_count = 0
        while t_upsert.is_alive():
            t_upsert.join(timeout=5)
            elapsed = time.time() - start_time
            rate = progress["total_chunks"] / elapsed if elapsed > 0 else 0

            if pbar:
                delta = progress["processed_docs"] - last_doc_count
                if delta > 0:
                    pbar.update(delta)
                    last_doc_count = progress["processed_docs"]

                # ETA calculation
                if progress["processed_docs"] > 0:
                    eta_s = (len(remaining) - progress["processed_docs"]) / (
                        progress["processed_docs"] / elapsed
                    )
                    if eta_s < 60:
                        eta_str = f"{eta_s:.0f}s"
                    elif eta_s < 3600:
                        eta_str = f"{eta_s / 60:.1f}m"
                    else:
                        eta_str = f"{eta_s / 3600:.1f}h"
                else:
                    eta_str = "..."

                pbar.set_postfix_str(
                    f"ETA: {eta_str} | {rate:.1f} ch/s | "
                    f"dedup: {progress['skipped_para_dup']}p/{progress['skipped_file_dup']}f | "
                    f"{progress['current_doc']}"
                )
            else:
                logger.info(
                    "Progress: %d/%d docs | %d chunks | %.1f chunks/sec | "
                    "dedup: %dp/%df | current: %s",
                    progress["processed_docs"],
                    len(remaining),
                    progress["total_chunks"],
                    rate,
                    progress["skipped_para_dup"],
                    progress["skipped_file_dup"],
                    progress["current_doc"],
                )
    except KeyboardInterrupt:
        logger.warning("Interrupted — signalling workers to stop...")
        cancel.set()
    finally:
        if pbar:
            pbar.close()

    # Wait for all threads to finish
    t_chunk.join(timeout=10)
    t_embed.join(timeout=30)
    t_upsert.join(timeout=10)

    # Merge failed lists
    checkpoint["failed"] = list(set(checkpoint.get("failed", []) + progress["failed"]))

    # Save final stats & state
    elapsed = time.time() - start_time
    total_chunks = progress["total_chunks"]
    checkpoint["stats"] = {
        "total_docs": len(checkpoint["processed"]),
        "total_chunks": total_chunks,
        "failed_docs": len(checkpoint["failed"]),
        "elapsed_seconds": round(elapsed, 1),
        "skipped_file_dup": progress["skipped_file_dup"],
        "skipped_para_dup": progress["skipped_para_dup"],
    }
    _save_checkpoint(checkpoint_path, checkpoint)
    _save_para_hashes(para_hash_path, para_hashes)
    _save_file_hashes(file_hash_path, file_hashes)

    # Write manifest
    manifest = {
        "collection_name": collection_name,
        "model": embedder.model,
        "dimension": COLLECTION_CONFIG["dense_dim"],
        "input_dir": str(input_path),
        "docs_processed": progress["processed_docs"],
        "total_chunks_embedded": total_chunks,
        "skipped_file_dup": progress["skipped_file_dup"],
        "skipped_para_dup": progress["skipped_para_dup"],
        "failed_docs": len(checkpoint["failed"]),
        "elapsed_seconds": round(elapsed, 1),
        "dry_run": dry_run,
        "no_write": no_write,
        "normalize_arabic": normalize_arabic,
        "max_concurrent": max_concurrent,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    _write_manifest(manifest_path, manifest)

    logger.info(
        "Ingestion complete: %d docs, %d chunks in %.1fs (%.1f chunks/sec) | "
        "dedup: %d para, %d file | failed: %d",
        progress["processed_docs"],
        total_chunks,
        elapsed,
        total_chunks / elapsed if elapsed > 0 else 0,
        progress["skipped_para_dup"],
        progress["skipped_file_dup"],
        len(progress["failed"]),
    )
    if progress["failed"]:
        logger.warning("Failed documents (%d): %s", len(progress["failed"]), progress["failed"][:10])


def main():
    parser = argparse.ArgumentParser(description="Ingest OCR documents into Qdrant")
    parser.add_argument("--input-dir", required=True, help="Path to output/ directory")
    parser.add_argument("--collection", default="academic_articles_v2", help="Qdrant collection name")
    parser.add_argument("--qdrant-url", default="http://localhost:6333", help="Qdrant server URL")
    parser.add_argument("--batch-size", type=int, default=100, help="Texts per OpenAI API call")
    parser.add_argument("--max-concurrent", type=int, default=10, help="Max concurrent OpenAI API requests")
    parser.add_argument("--limit", type=int, default=0, help="Max documents to process (0 = all)")
    parser.add_argument("--dry-run", action="store_true", help="Pre-scan stats only, no API calls")
    parser.add_argument("--no-write", action="store_true", help="Embed but skip Qdrant upsert")
    parser.add_argument("--no-resume", action="store_true", help="Start fresh, ignore checkpoint")
    parser.add_argument("--force-recreate", action="store_true", help="Drop and recreate Qdrant collection")
    parser.add_argument("--normalize-arabic", action="store_true", default=True, help="Enable Arabic normalization")
    parser.add_argument("--no-normalize-arabic", dest="normalize_arabic", action="store_false", help="Disable Arabic normalization")
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
        max_concurrent=args.max_concurrent,
        dry_run=args.dry_run,
        no_write=args.no_write,
        resume=not args.no_resume,
        limit=args.limit,
        force_recreate=args.force_recreate,
        normalize_arabic=args.normalize_arabic,
    )


if __name__ == "__main__":
    main()
