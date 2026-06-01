# Migration Plan: BGE-M3 → OpenAI text-embedding-3-small

## Context
The platform currently uses BGE-M3 (local, 1024-dim dense + sparse) for embeddings. We're switching to OpenAI `text-embedding-3-small` (API, 1536-dim dense) to use a different embedding model. There are also 3,269 new documents in `output_batch05/` to ingest. The old collection will be replaced once the new one is verified.

The new pipeline takes key patterns from `backend/legacy_embed.py` — the proven async OpenAI embedding code — and integrates them into the existing chunker→embedder→upserter architecture.

---

## Phase 1: Prepare (no production impact)

### 1a. Create shared Arabic text utilities
- **New file**: `backend/utils/arabic.py`
- Extract `_ARABIC_NORMALIZE_TABLE`, `_ARABIC_DIACRITICS_RE`, `_TOKEN_RE`, `_STOPWORDS` from `backend/services/search.py` (lines 29-52) into this shared module
- Update `search.py` to import from the shared module (refactor, no behavior change)

### 1b. Write new `OpenAIEmbedder` class in `backend/pipeline/embedder.py`
- Keep `EmbeddingResult` dataclass unchanged (dense, sparse_indices, sparse_values)
- Keep `BGEm3Embedder` intact alongside the new class (removed later)

**`OpenAIEmbedder`** — async-first, ported from `legacy_embed.py` patterns:
- Uses `openai.AsyncOpenAI` client for concurrent embedding requests
- **`AsyncRateLimiter`** (from legacy line 190-212): sliding-window rate limiter tracking requests/minute, configurable via `REQUESTS_PER_MINUTE` (default 2950)
- **`asyncio.Semaphore`** for concurrency cap: `MAX_CONCURRENT_REQUESTS` (default 10), configurable via `--max-concurrent` CLI flag
- **Batch size**: 100 texts per API call (`CHUNKS_PER_REQUEST` from legacy)
- **Retry with exponential backoff**: 5 retries, delay doubling from 2s (legacy lines 527-559)
- `encode()` and `encode_queries()` return `list[EmbeddingResult]` (same interface as BGE-M3)
- Internally uses `asyncio.gather()` to fire multiple batch requests concurrently (legacy line 700-701)

**`SparseVectorizer`** (in same file):
- TF-IDF-style term weighting with Arabic normalization (from shared utils)
- Hash-based vocabulary (token → `hash(token) % 30000`) — no fitting step needed
- Produces `(indices, values)` for Qdrant sparse vectors
- Qdrant's `Modifier.IDF` handles IDF weighting server-side

### 1c. Verify with a quick test
- Embed 5 sample Arabic texts, confirm 1536-dim dense + non-empty sparse output

---

## Phase 2: Update ingestion pipeline (`backend/pipeline/ingest.py`)

### 2a. Collection config — fully on-disk
- Change `dense_dim` from `1024` → `1536`
- New collection name: `academic_articles_v2` (via `COLLECTION_NAME` env var)
- **Vectors on disk**: `on_disk=True` on `VectorParams` (already present)
- **HNSW index on disk**: `on_disk=True` on `HnswConfigDiff` (already present)
- **Quantization on disk**: `always_ram=False` on `ScalarQuantizationConfig` (already present)
- Sparse vector config stays the same (with `Modifier.IDF`)
- **Dimension validation**: check existing collection dimension matches 1536 before ingesting; add `--force-recreate` flag to override (from legacy line 231-260)

### 2b. Pipeline architecture — async embedder stage
The current 3-stage pipeline (chunker→embedder→upserter) stays, but the **embedder stage becomes async** to leverage concurrent OpenAI API calls:

- Chunker thread → puts batches on `embed_queue` (unchanged)
- **Embedder stage** → pulls from queue, runs `asyncio.run()` to fire concurrent OpenAI requests via `asyncio.gather()` + semaphore, puts results on `upsert_queue`
- Upserter thread → upserts to Qdrant in sub-batches of 100-200 (unchanged)

### 2c. Deduplication (from legacy)
- **Paragraph-level**: `mmh3.hash64` of chunk text content → skip if already seen (legacy lines 89-91, 674-679)
- **File-level**: SHA1 of file bytes → skip entirely if file unchanged since last run (legacy lines 93-97, 664-669)
- Store hashes in checkpoint state files alongside the existing checkpoint JSON

### 2d. Safety & monitoring (from legacy)
- **Graceful shutdown**: signal handlers (`SIGINT`, `SIGTERM`) → set cancel event, save emergency checkpoint (legacy lines 99-113)
- **Memory monitoring**: `psutil` check + `gc.collect()` when memory exceeds threshold (legacy lines 119-140)
- **Dry-run mode**: pre-scan showing new vs duplicate chunks without calling OpenAI API (legacy lines 801-832)
- **No-write mode**: compute embeddings but skip Qdrant upsert (`--no-write` flag, legacy line 741)
- **Manifest JSON**: write run summary (model, dimension, counts, timestamps) at end of each run (legacy lines 975-996)
- **ETA & throughput**: live progress with `tqdm`, calculated ETA, files/min rate (legacy lines 160-188, 855-919)

### 2e. Checkpoint system — enhanced
Keep the existing checkpoint file (`ingest_checkpoint.json`) but add:
- Paragraph content hash set (for cross-run dedup)
- File content hash map (for file-level skip)
- Counters: attempted, upserted, skipped
- Emergency checkpoint on signal interrupt
- Checkpoint save every 100 files (configurable `CHECKPOINT_INTERVAL`)

### 2f. New CLI flags
```
--max-concurrent N    # Max concurrent OpenAI API requests (default 10)
--force-recreate      # Drop and recreate collection
--dry-run             # Pre-scan stats only, no API calls
--no-write            # Embed but skip Qdrant upsert
--normalize-arabic    # Toggle Arabic normalization (default on)
--limit N             # Max documents to process (already exists)
--no-resume           # Start fresh, ignore checkpoint (already exists)
```

---

## Phase 3: Update search service (`backend/services/search.py`)

- Swap `BGEm3Embedder` → `OpenAIEmbedder` in the `embedder` property (line 98-99)
- For query-time embedding: use synchronous wrapper around the async OpenAI call (single query, no need for concurrency)
- Everything else stays the same — hybrid/dense/sparse search, RRF fusion, reranking all work with the same `EmbeddingResult` interface

---

## Phase 4: Config changes

### `.env`
```
COLLECTION_NAME=academic_articles_v2
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIM=1536
MAX_CONCURRENT_REQUESTS=10
REQUESTS_PER_MINUTE=2950
```

### `requirements.txt` — add
```
mmh3          # For deterministic point IDs and content dedup hashing
psutil        # For memory monitoring
tqdm          # For progress bars during ingestion
```

### `requirements.txt` — remove later (after migration verified)
```
FlagEmbedding==1.3.5
sentence-transformers==5.3.0
# (and their heavy torch/transformers deps)
```

---

## Phase 5: Incremental testing strategy

| Step | Command | Verify |
|------|---------|--------|
| Dry run | `python -m backend.pipeline.ingest --input-dir output/ --collection academic_articles_v2 --dry-run --limit 100` | Pre-scan stats, no API calls |
| 100 docs | `python -m backend.pipeline.ingest --input-dir output/ --collection academic_articles_v2 --limit 100` | Collection exists, 1536-dim vectors, search returns results |
| 500 docs | Same with `--limit 500` | Monitor rate limits, costs, speed, memory usage |
| All existing | `--input-dir output/` (no limit) | Full search quality comparison, checkpoint resume works |
| Batch05 | `--input-dir output_batch05/` | New docs searchable, dedup works across runs |

---

## Phase 6: Cutover & cleanup

1. Update `.env`: `COLLECTION_NAME=academic_articles_v2`
2. Restart FastAPI
3. Smoke test via frontend (all search modes, HyDE, synthesis, chat)
4. Keep old `academic_articles` collection for 1-2 weeks as rollback
5. After verification: remove `BGEm3Embedder`, drop old collection, remove heavy ML deps from requirements

---

## Files to modify

| File | Change |
|------|--------|
| `backend/utils/arabic.py` | **NEW** — shared Arabic normalization |
| `backend/utils/__init__.py` | **NEW** — empty init |
| `backend/pipeline/embedder.py` | Add `OpenAIEmbedder` + `SparseVectorizer` + `AsyncRateLimiter` |
| `backend/pipeline/ingest.py` | Async embedder stage, 1536 dims, dedup, safety features, new CLI flags, fully on-disk config |
| `backend/services/search.py` | Swap embedder import, import shared normalization |
| `.env` | Update `COLLECTION_NAME`, add embedding config |
| `requirements.txt` | Add `mmh3`, `psutil`, `tqdm`; later remove `FlagEmbedding` etc. |

---

## Risk mitigation

| Risk | Mitigation |
|------|------------|
| Old collection untouched | Different name (`academic_articles_v2`) |
| Interrupted runs | Checkpoint + emergency save on SIGINT/SIGTERM |
| Duplicate content | Paragraph-level + file-level content hashing |
| Rate limits | `AsyncRateLimiter` (2950 RPM) + semaphore (10 concurrent) + exponential backoff |
| Memory pressure | `psutil` monitoring + `gc.collect()` at threshold |
| Cost | ~$0.13 for full ingestion (trivial) |
| Dimension mismatch | Validate existing collection dims; `--force-recreate` to override |
| Sparse quality | TF-IDF hashing is simpler than BGE-M3 learned sparse; monitor hybrid vs dense-only quality |
| Disk storage | All vectors + HNSW index + quantization stored on disk (`on_disk=True`, `always_ram=False`) |
