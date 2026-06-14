"""
Document ingestion pipeline with async OpenAI embeddings.

Reads OCR documents -> chunks them -> embeds with OpenAI -> upserts to Qdrant.

Two input modes:
    --input-dir    output/-style tree of per-article Azure DI JSON files
    --input-jsonl  directory of *.jsonl(.gz) content shards produced by
                   scripts/extract_content.py (one {"doc_id", "batch",
                   "content"} object per line)

Architecture:
    [Chunker Thread] --queue--> [Embedder Thread (async)] --queue--> [Upserter Thread]

    Stage 1 (Chunker):  Reads documents, chunks them, batches them
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
    python -m backend.pipeline.ingest --input-jsonl content_shards/ --collection academic_articles_v2
    python -m backend.pipeline.ingest --input-jsonl content_shards/ --dry-run --limit 100
    python -m backend.pipeline.ingest --input-dir output/ --collection academic_articles_v2 --max-concurrent 8
"""

from __future__ import annotations

import argparse
import gc
import gzip
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
from itertools import islice
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


def _find_shards(input_dir: Path) -> list[Path]:
    """Find content shards (*.jsonl / *.jsonl.gz) produced by extract_content.py."""
    return sorted(
        p for p in input_dir.iterdir()
        if p.is_file() and (p.name.endswith(".jsonl") or p.name.endswith(".jsonl.gz"))
    )


# ── Document record sources ──────────────────────────────────────────────
#
# Both generators yield (doc_id, content, doc_meta, fhash) records for the
# chunk worker. content=None means "already known unchanged — checkpoint the
# doc id without re-embedding". fhash is (key, sha1) to record in the
# file-hash store after successful chunking, or None when not applicable.


def _iter_dir_docs(remaining: list[Path], file_hashes: dict[str, str], progress: dict,
                   marc_lookup=None):
    """Yield records from per-article Azure DI JSON files (--input-dir mode)."""
    for json_path in remaining:
        doc_id = json_path.stem
        try:
            current_fhash = _file_content_hash(json_path)
            if current_fhash and file_hashes.get(json_path.name) == current_fhash:
                yield doc_id, None, None, None
                continue

            with open(json_path) as f:
                data = json.load(f)
            content = data.get("content", "")
            fhash = (json_path.name, current_fhash) if current_fhash else None
            meta = _merge_marc(_extract_metadata_from_path(json_path), doc_id, marc_lookup, progress)
            yield doc_id, content, meta, fhash
        except Exception as e:
            logger.error("Reading failed for %s: %s", doc_id, e, exc_info=True)
            progress["failed"].append(doc_id)


def _iter_shard_docs(shards: list[Path], processed_ids: set[str], progress: dict,
                     marc_lookup=None):
    """Yield records from JSONL content shards (--input-jsonl mode).

    Resume filtering happens here (the shard is the unit of storage, not the
    document, so the upfront path filtering used in dir mode does not apply).
    """
    for shard in shards:
        opener = gzip.open if shard.name.endswith(".gz") else open
        try:
            with opener(shard, "rt", encoding="utf-8") as f:
                for lineno, line in enumerate(f, 1):
                    if not line.strip():
                        continue
                    try:
                        rec = json.loads(line)
                        doc_id = rec["doc_id"]
                    except Exception as e:
                        logger.error("Bad record %s:%d: %s", shard.name, lineno, e)
                        progress["failed"].append(f"{shard.name}:{lineno}")
                        continue
                    if doc_id in processed_ids:
                        continue
                    meta = _extract_metadata_from_id(doc_id)
                    if rec.get("batch"):
                        meta["batch"] = rec["batch"]
                    _merge_marc(meta, doc_id, marc_lookup, progress)
                    yield doc_id, rec.get("content", ""), meta, None
        except Exception as e:
            logger.error("Failed to read shard %s: %s", shard, e, exc_info=True)
            progress["failed"].append(shard.name)


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


def _extract_metadata_from_id(doc_id: str) -> dict:
    """Extract journal/volume/issue/article metadata from the document ID."""
    parts = doc_id.split("-")
    meta = {"doc_id": doc_id}
    if len(parts) == 4:
        meta["journal_id"] = parts[0]
        meta["volume"] = parts[1]
        meta["issue"] = parts[2]
        meta["article_num"] = parts[3]
    return meta


def _extract_metadata_from_path(json_path: Path) -> dict:
    """Extract journal/volume/issue/article metadata from the file path and ID."""
    return _extract_metadata_from_id(json_path.stem)


# JSON-encoded list columns in the MARC sidecar (see extract_marc_metadata.py).
_MARC_LIST_COLS = ("keywords", "authors", "database")


def _open_marc_lookup(marc_db: str):
    """Open the MARC metadata sidecar read-only and return (lookup_fn, conn).

    lookup_fn(doc_id) -> dict of non-empty fields (list columns decoded), or
    None when the document has no catalogue record. The connection is opened
    with check_same_thread=False because the chunker thread consumes the
    record iterator that calls the lookup.
    """
    import sqlite3

    conn = sqlite3.connect(f"file:{marc_db}?mode=ro", uri=True, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    table = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='marc'"
    ).fetchone()
    if table is None:
        conn.close()
        raise ValueError(f"No 'marc' table found in {marc_db}")

    def lookup(doc_id: str) -> dict | None:
        row = conn.execute("SELECT * FROM marc WHERE doc_id = ?", (doc_id,)).fetchone()
        if row is None:
            return None
        out: dict = {}
        for key in row.keys():
            val = row[key]
            if val is None or val == "":
                continue
            if key in _MARC_LIST_COLS:
                try:
                    val = json.loads(val)
                except (ValueError, TypeError):
                    pass
            out[key] = val
        return out

    return lookup, conn


def _merge_marc(meta: dict, doc_id: str, marc_lookup, progress: dict) -> dict:
    """Merge MARC sidecar fields into a document's metadata dict in place."""
    if marc_lookup is None:
        return meta
    record = marc_lookup(doc_id)
    if record:
        meta.update(record)
    else:
        progress["marc_missing"] = progress.get("marc_missing", 0) + 1
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
        # MARC metadata filters (populated when --marc-db is supplied)
        ("journal", models.PayloadSchemaType.KEYWORD),
        ("authors", models.PayloadSchemaType.KEYWORD),
        ("year", models.PayloadSchemaType.KEYWORD),
        ("country", models.PayloadSchemaType.KEYWORD),
        ("database", models.PayloadSchemaType.KEYWORD),
        ("category", models.PayloadSchemaType.KEYWORD),
        ("issn", models.PayloadSchemaType.KEYWORD),
        ("keywords", models.PayloadSchemaType.KEYWORD),
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
    records,
    batch_size: int,
    embed_queue: queue.Queue,
    progress: dict,
    cancel: threading.Event,
    para_hashes: set[str],
    file_hashes: dict[str, str],
    para_hashes_lock: threading.Lock,
):
    """Chunk document records and produce batches for embedding.

    `records` is an iterator of (doc_id, content, doc_meta, fhash) from
    _iter_dir_docs or _iter_shard_docs. Performs paragraph-level dedup;
    file-level dedup arrives pre-computed as content=None records.
    """
    batch_chunks: list[Chunk] = []
    batch_payloads: list[dict] = []
    batch_doc_ids: list[str] = []

    try:
        for doc_id, content, doc_meta, fhash in records:
            if cancel.is_set():
                break

            progress["current_doc"] = doc_id

            try:
                if content is None:
                    # File-level skip: unchanged — checkpoint without re-embedding
                    progress["skipped_file_dup"] += 1
                    batch_doc_ids.append(doc_id)
                    continue

                if not content or len(content.strip()) < 100:
                    logger.warning("Skipping %s: content too short", doc_id)
                    progress["failed"].append(doc_id)
                    continue

                meta = doc_meta or {}
                result = chunk_document(
                    content, doc_id,
                    title=meta.get("title"),
                    keywords=meta.get("keywords"),
                    abstract=meta.get("abstract"),
                )

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
                if fhash:
                    file_hashes[fhash[0]] = fhash[1]

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


def _dry_run_scan(records, para_hashes: set[str]) -> dict:
    """Pre-scan document records to show dedup stats without calling the API."""
    total_docs = 0
    unchanged_files = 0
    new_files = 0
    total_paras = 0
    dup_paras = 0
    seen = set(para_hashes)

    for doc_id, content, _meta, _fhash in records:
        total_docs += 1
        if content is None:
            unchanged_files += 1
            continue
        if not content or len(content.strip()) < 100:
            continue

        try:
            result = chunk_document(content, doc_id)
        except Exception:
            continue
        new_files += 1
        for chunk in result.chunks:
            total_paras += 1
            h = _paragraph_content_hash(chunk.text)
            if h in seen:
                dup_paras += 1
            else:
                seen.add(h)

    stats = {
        "total_docs": total_docs,
        "unchanged_files": unchanged_files,
        "new_files": new_files,
        "total_paras": total_paras,
        "dup_paras": dup_paras,
        "unique_paras": total_paras - dup_paras,
    }
    logger.info("DRY RUN Pre-scan Results:")
    logger.info("  Total docs scanned:      %d", stats["total_docs"])
    logger.info("  Unchanged (file skip):   %d", stats["unchanged_files"])
    logger.info("  New/changed docs:        %d", stats["new_files"])
    logger.info("  Total paragraphs (raw):  %d", stats["total_paras"])
    logger.info("  Duplicate paragraphs:    %d", stats["dup_paras"])
    logger.info("  Unique new paragraphs:   %d", stats["unique_paras"])
    logger.info("(No embeddings generated in dry run.)")
    return stats


# ── Orchestrator ─────────────────────────────────────────────────────────


def ingest_documents(
    input_dir: str | None = None,
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
    input_jsonl: str | None = None,
    marc_db: str | None = None,
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
        input_jsonl: Path to a directory of *.jsonl(.gz) content shards
            (from scripts/extract_content.py). Exactly one of input_dir /
            input_jsonl must be given.
        marc_db: Optional path to the MARC metadata sidecar SQLite DB (from
            scripts/extract_marc_metadata.py). When given, each document is
            enriched with its catalogue record: authoritative title + keywords
            are folded into the embedded text, an abstract chunk is emitted
            where present, and bibliographic fields are stored as payload.
    """
    from backend.pipeline.embedder import OpenAIEmbedder

    if bool(input_dir) == bool(input_jsonl):
        raise ValueError("Provide exactly one of input_dir or input_jsonl")

    input_path = Path(input_dir or input_jsonl)
    checkpoint_path = input_path / CHECKPOINT_FILE
    para_hash_path = input_path / PARA_HASH_FILE
    file_hash_path = input_path / FILE_HASH_FILE
    manifest_path = input_path / MANIFEST_FILE

    # Load checkpoint & dedup state
    checkpoint = (
        _load_checkpoint(checkpoint_path)
        if resume
        else {"processed": [], "failed": [], "stats": {}}
    )
    para_hashes = _load_para_hashes(para_hash_path) if resume else set()
    file_hashes = _load_file_hashes(file_hash_path) if resume else {}
    processed_ids = set(checkpoint["processed"])

    # Optional MARC metadata sidecar (authoritative title/keywords/abstract + payload)
    marc_lookup = None
    marc_conn = None
    if marc_db:
        marc_lookup, marc_conn = _open_marc_lookup(marc_db)
        logger.info("MARC sidecar loaded: %s", marc_db)

    # Shared progress state (record iterators report read failures into it)
    progress = {
        "processed_docs": 0,
        "total_chunks": 0,
        "current_doc": "",
        "failed": [],
        "skipped_file_dup": 0,
        "skipped_para_dup": 0,
        "marc_missing": 0,
    }

    # Build the document record source
    total_docs: int | None = None
    if input_jsonl:
        shards = _find_shards(input_path)
        logger.info("Found %d content shards in %s", len(shards), input_jsonl)
        if not shards:
            logger.warning("No content shards (*.jsonl / *.jsonl.gz) found!")
            return

        records = _iter_shard_docs(shards, processed_ids, progress, marc_lookup)
        if limit > 0:
            records = islice(records, limit)
            total_docs = limit
        else:
            # Best-effort total from the extraction manifest, if present
            extract_manifest = input_path / "extract_manifest.json"
            if extract_manifest.exists():
                try:
                    est = json.loads(extract_manifest.read_text())["total_docs"]
                    total_docs = max(est - len(processed_ids), 0) or None
                except Exception:
                    pass
        logger.info(
            "Already processed: %d, Remaining: %s, Paragraph hashes: %d",
            len(processed_ids), total_docs if total_docs is not None else "unknown",
            len(para_hashes),
        )
    else:
        json_files = _find_json_files(input_path)
        logger.info("Found %d JSON files in %s", len(json_files), input_dir)
        if not json_files:
            logger.warning("No JSON files found!")
            return

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
        total_docs = len(remaining)
        records = _iter_dir_docs(remaining, file_hashes, progress, marc_lookup)

    # Dry-run: pre-scan only
    if dry_run:
        _dry_run_scan(records, para_hashes)
        if marc_conn is not None:
            logger.info("MARC: %d documents had no catalogue record", progress["marc_missing"])
            marc_conn.close()
        return

    # Initialize embedder
    embedder = OpenAIEmbedder(batch_size=batch_size, max_concurrent=max_concurrent)

    # Initialize Qdrant
    client = None
    if not no_write:
        from qdrant_client import QdrantClient

        client = QdrantClient(url=qdrant_url, timeout=120)
        create_collection(client, collection_name, force_recreate=force_recreate)

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
        args=(records, batch_size, embed_queue, progress, cancel,
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
        "Pipeline started: %s docs to process (chunker -> embedder[async x%d] -> upserter)",
        total_docs if total_docs is not None else "?",
        max_concurrent,
    )

    # Monitor progress with tqdm
    try:
        from tqdm import tqdm

        pbar = tqdm(
            total=total_docs,
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

            if pbar is not None:
                delta = progress["processed_docs"] - last_doc_count
                if delta > 0:
                    pbar.update(delta)
                    last_doc_count = progress["processed_docs"]

                # ETA calculation (only when the total is known)
                if total_docs is not None and progress["processed_docs"] > 0:
                    eta_s = (total_docs - progress["processed_docs"]) / (
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
                    "Progress: %d/%s docs | %d chunks | %.1f chunks/sec | "
                    "dedup: %dp/%df | current: %s",
                    progress["processed_docs"],
                    total_docs if total_docs is not None else "?",
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
        if pbar is not None:
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
        "marc_db": marc_db,
        "marc_missing": progress["marc_missing"],
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    _write_manifest(manifest_path, manifest)

    if marc_conn is not None:
        logger.info("MARC: %d documents had no catalogue record", progress["marc_missing"])
        marc_conn.close()

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
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--input-dir", help="Path to output/ directory of per-article JSON files")
    src.add_argument("--input-jsonl", help="Path to directory of *.jsonl(.gz) content shards")
    parser.add_argument("--marc-db", help="Path to MARC metadata sidecar (scripts/extract_marc_metadata.py)")
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
        input_jsonl=args.input_jsonl,
        marc_db=args.marc_db,
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
