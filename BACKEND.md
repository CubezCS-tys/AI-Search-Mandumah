# Backend Documentation — AI Search Mandumah

> Comprehensive reference for the FastAPI server and all pipeline modules.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Directory Layout](#2-directory-layout)
3. [Data Model & Document Format](#3-data-model--document-format)
4. [API Server (`api/main.py`)](#4-api-server-apimainpy)
5. [Chunker (`pipeline/chunker.py`)](#5-chunker-pipelinechunkerpy)
6. [Embedder (`pipeline/embedder.py`)](#6-embedder-pipelineembedderpy)
7. [Ingestion Pipeline (`pipeline/ingest.py`)](#7-ingestion-pipeline-pipelineingestpy)
8. [Search (`pipeline/search.py`)](#8-search-pipelinesearchpy)
9. [Test Utilities (`pipeline/test_chunker.py`)](#9-test-utilities-pipelinetest_chunkerpy)
10. [Qdrant Collection Schema](#10-qdrant-collection-schema)
11. [Configuration & Constants](#11-configuration--constants)
12. [CLI Reference](#12-cli-reference)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend (Next.js)                       │
│              http://localhost:3000                               │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTP
┌────────────────────────▼────────────────────────────────────────┐
│                    FastAPI Server                                │
│              http://localhost:8000                               │
│                                                                 │
│   /api/search           → Searcher (hybrid/dense/sparse)        │
│   /api/pdf/{doc_id}     → Static PDF file serving               │
│   /api/document/…/ocr   → Azure DI JSON + raster dimensions     │
│   /api/document/…/image → On-the-fly WebP page rasterization   │
│   /api/health           → Qdrant connectivity check             │
└────────────────┬────────────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────────────┐
│                     Qdrant Vector DB                            │
│              http://localhost:6333                               │
│              Collection: academic_articles                       │
│              Dense: 1024d COSINE   Sparse: IDF-weighted          │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

**Ingestion** (offline, one-time):

```
Azure DI JSON files  →  Chunker  →  Embedder (BGE-M3)  →  Qdrant upsert
       (output/)          (thread 1)     (thread 2)          (thread 3)
```

**Search** (online, per-request):

```
User query  →  BGE-M3 encode  →  Qdrant hybrid search  →  RRF fusion  →  Results
```

**Document Viewing** (online, per-request):

```
Frontend requests  →  PDF / OCR JSON / page WebP  →  Custom word-level viewer
```

---

## 2. Directory Layout

```
project/
├── api/
│   ├── __init__.py          # Empty
│   └── main.py              # FastAPI application (≈300 lines)
│
├── pipeline/
│   ├── __init__.py          # Empty
│   ├── chunker.py           # Structure-aware Arabic chunker (≈399 lines)
│   ├── embedder.py          # BGE-M3 embedding wrapper (≈131 lines)
│   ├── ingest.py            # 3-stage pipelined ingestion (≈526 lines)
│   ├── search.py            # Hybrid search with RRF (≈291 lines)
│   └── test_chunker.py      # Chunker validation script (≈86 lines)
│
├── output/                  # Azure Document Intelligence output
│   ├── ingest_checkpoint.json
│   ├── output_XXXX/         # Per-journal folder
│   │   └── XXXX-YYY-ZZZ-NNN/  # Per-article folder
│   │       ├── {doc_id}.json   # Azure DI analysis result
│   │       ├── {doc_id}.pdf    # Original PDF
│   │       └── {doc_id}.html   # (unused) HTML rendition
│   └── ...
│
├── storage/                 # Qdrant on-disk storage
├── snapshots/               # Qdrant snapshots
└── qdrant                   # Qdrant binary
```

---

## 3. Data Model & Document Format

### Document ID Convention

Document IDs follow the pattern `JJJJ-VVV-III-AAA`:
- `JJJJ` — Journal ID (zero-padded, e.g. `0005`)
- `VVV` — Volume number (e.g. `076`)
- `III` — Issue number (e.g. `002`)
- `AAA` — Article number within issue (e.g. `003`)

The journal ID is extracted as the first 4 characters of the doc_id.

### Azure Document Intelligence JSON

Each article has a JSON file from Azure Document Intelligence with this structure:

```jsonc
{
  "content": "Full extracted text of the document...",
  "pages": [
    {
      "pageNumber": 1,
      "width": 8.2639,      // Page width in inches
      "height": 11.6944,    // Page height in inches
      "words": [
        {
          "content": "الملخص",
          "polygon": [x1,y1, x2,y2, x3,y3, x4,y4],  // 8 floats, 4 corners in inches
          "confidence": 0.995,
          "span": { "offset": 0, "length": 6 }
        }
      ],
      "lines": [...],
      "spans": [...]
    }
  ],
  "paragraphs": [...],
  "tables": [...],
  "styles": [...]
}
```

**Coordinate system:** All polygon coordinates are in **inches** from the top-left corner. The frontend converts to pixels using `coord × (200 / 72) × 72 = coord × 200` (since rasterization is at 200 DPI).

### Chunk Data Model

Each chunk stored in Qdrant carries these fields as payload:

| Field | Type | Description |
|-------|------|-------------|
| `chunk_id` | `str` | `{doc_id}_chunk_{N}` |
| `doc_id` | `str` | Parent document ID |
| `journal_id` | `str` | First 4 chars of doc_id |
| `title` | `str` | Document title (first 200 chars of content) |
| `section` | `str` | Detected section header or `"body"` |
| `text` | `str` | Raw chunk text |
| `embed_text` | `str` | Enriched text: title + section header + text |
| `char_len` | `int` | Character length of `text` |
| `page_start` | N/A | *(defined in dataclass, not currently populated)* |
| `page_end` | N/A | *(defined in dataclass, not currently populated)* |

---

## 4. API Server (`api/main.py`)

### Setup & Dependencies

```python
FastAPI(title="Mandumah Search API")
CORSMiddleware  # allows all origins (dev mode)
```

- **Lazy-loaded Searcher**: The `Searcher` instance is created on first search request to avoid loading the BGE-M3 model (~2GB) at server startup.
- **In-memory page image cache**: `_page_image_cache: dict[str, bytes]` caches rendered page WebP images to avoid re-rasterization.
- **Output directory**: Resolved at startup as `Path(__file__).resolve().parent.parent / "output"`.

### Endpoints

#### `GET /api/health`

Checks Qdrant connectivity and returns collection info.

**Response:**
```json
{
  "status": "ok",
  "qdrant": "connected",
  "collection": "academic_articles",
  "points_count": 1234,
  "vectors_count": 1234
}
```

On failure returns `{"status": "error", "detail": "..."}` with status 503.

#### `POST /api/search`

Performs vector search over the Qdrant collection.

**Request body (`SearchRequest`):**
```json
{
  "query": "البحث العلمي",
  "top_k": 20,
  "mode": "hybrid",
  "journal_id": null,
  "section": null,
  "doc_id": null
}
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | `str` | required | Search query text |
| `top_k` | `int` | `20` | Number of results |
| `mode` | `str` | `"hybrid"` | `"hybrid"`, `"dense"`, or `"sparse"` |
| `journal_id` | `str?` | `null` | Filter by journal |
| `section` | `str?` | `null` | Filter by section |
| `doc_id` | `str?` | `null` | Filter by document |

**Response:**
```json
{
  "results": [
    {
      "chunk_id": "0005-076-002-001_chunk_3",
      "doc_id": "0005-076-002-001",
      "journal_id": "0005",
      "title": "عنوان المقال...",
      "section": "المقدمة",
      "text": "Chunk content...",
      "score": 0.842
    }
  ],
  "query": "البحث العلمي",
  "mode": "hybrid",
  "total": 15
}
```

**Deduplication:** Results are deduplicated by `doc_id`, keeping only the highest-scoring chunk per document.

#### `GET /api/pdf/{doc_id}`

Serves the original PDF file for a document.

- Looks up `output/output_{journal_id}/{doc_id}/{doc_id}.pdf`
- Returns `FileResponse` with `application/pdf` media type
- Returns 404 if not found

#### `GET /api/document/{doc_id}/ocr`

Returns the Azure Document Intelligence JSON for a document, augmented with raster pixel dimensions for each page.

**Processing:**
1. Opens the PDF with PyMuPDF to get actual page dimensions
2. Computes raster size at 200 DPI: `width_px = int(page.rect.width * 200/72)`, `height_px = int(page.rect.height * 200/72)`
3. Injects `raster_width_px` and `raster_height_px` into each page object in the JSON

**Response:** The full Azure DI JSON with added raster dimensions per page.

#### `GET /api/document/{doc_id}/page/{page_num}/image`

Renders a single PDF page as a WebP image.

**Processing:**
1. Cache key: `f"{doc_id}_{page_num}"`
2. If cached, returns immediately with `ETag` and `Cache-Control: public, max-age=86400`
3. Otherwise: opens PDF, renders page at 200 DPI (`fitz.Matrix(200/72, 200/72)`), converts to PIL Image, encodes as WebP (quality=85)
4. Stores in `_page_image_cache` and returns

**Headers:**
- `Content-Type: image/webp`
- `Cache-Control: public, max-age=86400`
- `ETag: "{doc_id}_{page_num}"`

Supports `If-None-Match` → returns 304 Not Modified.

### Helper Functions

#### `_find_doc_path(doc_id: str) → Path | None`

Locates a document's directory by doc_id. Walks through all `output_*` journal directories looking for a subdirectory matching the doc_id.

#### `_resolve_pdf(doc_id: str) → Path | None`

Finds the PDF file for a doc_id. Calls `_find_doc_path` then checks for `{doc_id}.pdf`.

#### `_resolve_json(doc_id: str) → Path | None`

Finds the JSON file for a doc_id. Calls `_find_doc_path` then checks for `{doc_id}.json`.

### Error Handling

- All endpoints wrap main logic in try/except, returning 500 with detail message on unexpected errors.
- 404 returned when document/PDF/JSON not found.
- 400 returned for invalid search mode.

---

## 5. Chunker (`pipeline/chunker.py`)

### Purpose

Splits the raw text extracted by Azure Document Intelligence into semantically meaningful, overlapping chunks optimized for Arabic academic articles. The chunker is structure-aware: it detects section headers, skips reference/bibliography sections, and preserves sentence boundaries.

### Configuration Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `TARGET_TOKENS` | `400` | Target chunk size in tokens |
| `CHARS_PER_TOKEN` | `4` | Estimated characters per Arabic token |
| `TARGET_CHARS` | `1600` | `TARGET_TOKENS × CHARS_PER_TOKEN` |
| `MIN_CHARS` | `400` | Minimum chunk size |
| `MAX_CHARS` | `2400` | Maximum chunk size |
| `OVERLAP_RATIO` | `0.10` | 10% overlap between consecutive chunks |
| `OVERLAP_CHARS` | `160` | `TARGET_CHARS × OVERLAP_RATIO` |

### Data Classes

```python
@dataclass
class Chunk:
    chunk_id: str          # "{doc_id}_chunk_{n}"
    doc_id: str
    title: str             # First 200 chars of document
    section: str           # Detected section or "body"
    text: str              # Raw chunk text
    embed_text: str        # Title + section header + text (for embedding)
    char_len: int          # len(text)
    page_start: int | None
    page_end: int | None

@dataclass
class ChunkResult:
    chunks: list[Chunk]
    skipped_reference_chars: int
```

### Three-Phase Processing

#### Phase 1: Line Cleaning (`_clean_lines`)

Processes the raw text line-by-line:

1. **Strips whitespace** from each line
2. **Skips empty lines**
3. **Detects reference/bibliography sections** — once detected, all remaining lines are skipped. Detection uses regex patterns:
   - Arabic patterns: `المراجع`, `المصادر`, `قائمة المراجع`, `الهوامش`, etc.
   - English patterns: `References`, `Bibliography`, `Works Cited`
   - Numbered reference patterns: Lines starting with `[1]`, `(1)`, etc.
4. **Filters out boilerplate lines** — page numbers, headers/footers, author lines, copyright notices. A line is considered boilerplate if it matches `_is_boilerplate()`:
   - Pure digits (page numbers)
   - Very short lines (≤3 chars or ≤5 chars with non-alpha majority)
   - Lines matching `_RE_BOILERPLATE` (journal metadata patterns)
   - Lines matching `_RE_AUTHOR_LINE` (author name patterns)
5. **Detects section headers** — lines matching `_RE_SECTION` are tagged as headers (not included in body text, but stored as the current section label). Patterns match Arabic header formats like:
   - `أولاً:`, `ثانياً:`, `1.`, `1-1`, `أ-`, etc.
   - Standalone keywords: `المقدمة`, `الخاتمة`, `النتائج`, `التوصيات`, etc.
   - Headers are validated: must be ≤120 chars and ≤60% digits

**Returns:** `list[tuple[str, str | None]]` — pairs of `(line_text, section_header_or_None)`

#### Phase 2: Build Chunks (`_build_chunks`)

Takes cleaned lines and assembles them into chunks:

1. Joins consecutive lines into a running buffer
2. When buffer exceeds `TARGET_CHARS`:
   - Finds a **sentence boundary** in the region `[TARGET_CHARS - TARGET_CHARS//4 : TARGET_CHARS + TARGET_CHARS//4]` using `_find_sentence_boundary()`
   - Sentence boundaries are: `.` `؟` `!` `؛` (Arabic semicolon) followed by whitespace, or `\n\n` (paragraph break)
   - Cuts at the boundary (or at `TARGET_CHARS` if no boundary found)
   - Adds the chunk, then carries over `OVERLAP_CHARS` from the end of the chunk as the start of the next buffer
3. Final remaining text becomes the last chunk

#### Phase 3: Post-Processing

Merges undersized chunks (< `MIN_CHARS`) with adjacent chunks:
- If a small chunk exists and the previous chunk is below `MAX_CHARS`, merges with previous
- Otherwise, if a following chunk exists and combined length is ≤ `MAX_CHARS`, merges with next

### Embed Text Construction

Each chunk's `embed_text` is constructed as:

```
العنوان: {title}
{section_header}
{chunk_text}
```

This prepends the document title (prefixed with "العنوان:" meaning "Title:") and the current section header to give the embedding model better context for retrieval.

### Entry Point: `chunk_document(content, doc_id)`

```python
def chunk_document(content: str, doc_id: str) -> ChunkResult:
```

Takes the full `content` string from the Azure DI JSON and the document ID. Returns a `ChunkResult` with all chunks and a count of skipped reference characters.

---

## 6. Embedder (`pipeline/embedder.py`)

### Purpose

Wraps the BGE-M3 model from the FlagEmbedding library to produce both dense (1024-dimensional) and learned sparse embeddings for text. Used by both the ingestion pipeline (batch encoding of chunks) and the search module (single-query encoding).

### Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `model_name` | `"BAAI/bge-m3"` | HuggingFace model identifier |
| `batch_size` | `32` | Batch size for encoding |
| `max_length` | `8192` | Maximum token sequence length |
| `use_fp16` | `True` | Use half-precision for GPU acceleration |

### Data Class

```python
@dataclass
class EmbeddingResult:
    dense: list[float]          # 1024-dimensional dense vector
    sparse_indices: list[int]   # Token IDs with non-zero weights
    sparse_values: list[float]  # Corresponding weights
```

### Class: `BGEm3Embedder`

#### `__init__(model_name, batch_size, max_length, use_fp16)`

Stores configuration but **does not load the model**. Model loading is deferred to first use.

#### `_load_model()`

Loads the `BGEM3FlagModel` from FlagEmbedding. Called lazily on first `encode()` call. Prints timing information.

#### `encode(texts: list[str]) → list[EmbeddingResult]`

1. Loads model if not yet loaded
2. Calls `model.encode()` with `return_dense=True, return_sparse=True, return_colbert_vecs=False`
3. Extracts dense vectors from `output["dense_vecs"]` (numpy → list)
4. Extracts sparse vectors from `output["lexical_weights"]` — each is a dict `{token_id: weight}`, converted to parallel `indices` and `values` lists
5. Returns list of `EmbeddingResult` objects

**Batch processing:** The FlagEmbedding library handles internal batching based on the configured `batch_size`.

---

## 7. Ingestion Pipeline (`pipeline/ingest.py`)

### Purpose

Reads all Azure DI JSON documents from the output directory, chunks them, embeds them with BGE-M3, and upserts the vectors + metadata into Qdrant. Uses a 3-stage pipelined architecture with separate threads for I/O-bound and compute-bound stages.

### Architecture

```
┌──────────────┐     Queue(4)     ┌──────────────┐     Queue(4)     ┌──────────────┐
│   Chunker    │ ──────────────►  │   Embedder   │ ──────────────►  │   Upserter   │
│   Thread     │                  │   Thread      │                  │   Thread     │
│              │                  │              │                  │              │
│ Read JSON    │                  │ BGE-M3       │                  │ Qdrant       │
│ chunk_doc()  │                  │ encode()     │                  │ upsert()     │
│ ~fast        │                  │ ~slow (GPU)  │                  │ ~medium      │
└──────────────┘                  └──────────────┘                  └──────────────┘
```

- Bounded queues (`maxsize=4`) prevent memory overflow when the embedder is slower than the chunker.
- Sentinel values (`None`) signal thread completion.
- Embedding is the bottleneck — the pipeline ensures the GPU is always busy.

### Checkpoint / Resume

**Checkpoint file:** `output/ingest_checkpoint.json`

```json
{
  "completed": ["0005-076-002-001", "0005-076-002-002", ...],
  "last_updated": "2024-01-15T10:30:00"
}
```

- On startup, the pipeline reads this file and skips already-completed documents.
- After each document is successfully upserted, it's added to the checkpoint.
- Enables safe interruption and resumption of long ingestion runs.

### Collection Creation (`create_collection`)

Sets up the Qdrant collection with:

**Dense vectors:**
- Name: `"dense"`
- Size: 1024 dimensions
- Distance: Cosine similarity
- Storage: on-disk (`on_disk=True`)
- HNSW config: `m=16`, `ef_construct=256`
- Quantization: INT8 scalar (`always_ram=True`) for faster search with lower memory

**Sparse vectors:**
- Name: `"sparse"`
- Modifier: IDF (Inverse Document Frequency weighting)

**Payload indexes** (for filtering):
- `doc_id` — keyword index
- `journal_id` — keyword index
- `section` — keyword index
- `title` — keyword index

**Optimizers config:**
- `indexing_threshold=20000` — delays full index build until enough points exist

### Stage Functions

#### `_chunker_stage(doc_paths, checkpoint, out_queue)`

1. Iterates over all document JSON paths
2. Skips documents already in checkpoint
3. For each document:
   - Reads and parses the JSON
   - Extracts `content` field
   - Calls `chunk_document(content, doc_id)`
   - Puts `(doc_id, chunks)` onto `out_queue`
4. Sends `None` sentinel when done

#### `_embedder_stage(in_queue, out_queue, embedder)`

1. Reads `(doc_id, chunks)` from `in_queue`
2. Extracts `embed_text` from each chunk
3. Calls `embedder.encode(texts)` in batches
4. Puts `(doc_id, chunks, embeddings)` onto `out_queue`
5. Sends `None` sentinel when done

#### `_upserter_stage(in_queue, client, collection, checkpoint_path, checkpoint_set)`

1. Reads `(doc_id, chunks, embeddings)` from `in_queue`
2. Builds Qdrant `PointStruct` objects:
   - **Point ID:** `uuid.UUID(md5(chunk_id))` — deterministic, idempotent
   - **Vectors:** `{"dense": [...], "sparse": SparseVector(indices, values)}`
   - **Payload:** All chunk metadata fields
3. Upserts points in batches of 100
4. Adds doc_id to checkpoint and saves checkpoint file
5. Prints progress per document

### Entry Point: `ingest(input_dir, collection_name, recreate)`

```python
def ingest(input_dir: str, collection_name: str, recreate: bool = False):
```

1. Connects to Qdrant at `localhost:6333`
2. Optionally deletes and recreates the collection
3. Discovers all document JSON files in `input_dir`
4. Loads checkpoint
5. Initializes `BGEm3Embedder`
6. Starts 3 threads (chunker, embedder, upserter)
7. Waits for all threads to complete
8. Prints summary statistics

### CLI

```bash
python -m pipeline.ingest \
  --input-dir output/ \
  --collection academic_articles \
  --recreate  # optional: wipe and rebuild collection
```

---

## 8. Search (`pipeline/search.py`)

### Purpose

Provides hybrid (dense + sparse), dense-only, and sparse-only vector search over the Qdrant collection. Uses Reciprocal Rank Fusion (RRF) to combine dense and sparse results in hybrid mode.

### Data Class

```python
@dataclass
class SearchResult:
    chunk_id: str
    doc_id: str
    journal_id: str
    title: str
    section: str
    text: str
    score: float
```

### Class: `Searcher`

#### `__init__(collection_name, qdrant_url)`

| Parameter | Default | Description |
|-----------|---------|-------------|
| `collection_name` | `"academic_articles"` | Qdrant collection name |
| `qdrant_url` | `"http://localhost:6333"` | Qdrant server URL |

Creates Qdrant client. Embedder is **lazy-loaded** on first search.

#### `search(query, top_k, mode, journal_id, section, doc_id)`

Main entry point. Dispatches to the appropriate search strategy based on `mode`:

| Mode | Method | Description |
|------|--------|-------------|
| `"hybrid"` | `_hybrid_search()` | Dense + sparse with RRF fusion |
| `"dense"` | `_dense_search()` | Dense vectors only (semantic) |
| `"sparse"` | `_sparse_search()` | Sparse vectors only (lexical/keyword) |

All modes apply optional filtering via `_build_filter()`.

#### `_hybrid_search(query, top_k, qfilter)`

Uses Qdrant's `query_points` API with **server-side RRF fusion**:

```python
client.query_points(
    collection_name=...,
    prefetch=[
        Prefetch(query=dense_vector, using="dense", limit=top_k),
        Prefetch(query=sparse_vector, using="sparse", limit=top_k),
    ],
    query=FusionQuery(fusion=Fusion.RRF),
    limit=top_k,
    with_payload=True,
)
```

This sends both dense and sparse queries as prefetches, then Qdrant fuses them using Reciprocal Rank Fusion. RRF scores each result as:

$$\text{RRF}(d) = \sum_{r \in \text{rankings}} \frac{1}{k + \text{rank}_r(d)}$$

where $k = 60$ (Qdrant default). This gives robust results even when dense and sparse scores are on different scales.

#### `_dense_search(query, top_k, qfilter)`

Standard nearest-neighbor search using only the 1024-d dense vector:

```python
client.query_points(
    query=dense_vector,
    using="dense",
    limit=top_k,
    with_payload=True,
)
```

#### `_sparse_search(query, top_k, qfilter)`

Lexical search using learned sparse vectors:

```python
client.query_points(
    query=SparseVector(indices=..., values=...),
    using="sparse",
    limit=top_k,
    with_payload=True,
)
```

#### `_build_filter(journal_id, section, doc_id)`

Builds a Qdrant `Filter` with `must` conditions for any non-None parameters:

```python
Filter(must=[
    FieldCondition(key="journal_id", match=MatchValue(value=journal_id)),
    FieldCondition(key="section", match=MatchValue(value=section)),
    FieldCondition(key="doc_id", match=MatchValue(value=doc_id)),
])
```

Returns `None` if all parameters are `None`.

#### `_point_to_result(point)`

Converts a Qdrant `ScoredPoint` to a `SearchResult` dataclass, extracting payload fields.

### CLI

```bash
python -m pipeline.search \
  --query "تأثير التعليم الإلكتروني" \
  --top-k 5 \
  --mode hybrid \
  --journal-id 0005  # optional filter
```

Output format:
```
[0.842] 0005-076-002-001_chunk_3 | المقدمة
  عنوان المقال...
  Chunk text preview (first 200 chars)...
---
```

---

## 9. Test Utilities (`pipeline/test_chunker.py`)

### Purpose

Validates the chunker against all documents in the `output/` directory. Not a unit test framework — it's a standalone script that produces aggregate statistics.

### What It Measures

- **Document count** processed
- **Total chunks** generated
- **Average chunks per document**
- **Chunk size statistics:** average, min, max character lengths
- **Reference chars skipped** (total across all documents)
- **Chunk size distribution** in buckets: `<400`, `400-800`, `800-1200`, `1200-1600`, `1600-2000`, `2000+` — displayed as ASCII histogram
- **Errors**: empty chunks, empty embed_text, or exceptions

### Usage

```bash
python -m pipeline.test_chunker
```

---

## 10. Qdrant Collection Schema

### Collection: `academic_articles`

**Vectors:**

| Name | Type | Dimensions | Distance | Storage | Quantization |
|------|------|-----------|----------|---------|--------------|
| `dense` | Dense | 1024 | Cosine | On-disk | INT8 scalar (in RAM) |
| `sparse` | Sparse | Variable | Dot product | Default | None |

**HNSW Parameters:**
- `m = 16` (connections per node)
- `ef_construct = 256` (build-time search width)

**Payload Indexes:**

| Field | Index Type |
|-------|-----------|
| `doc_id` | Keyword |
| `journal_id` | Keyword |
| `section` | Keyword |
| `title` | Keyword |

**Point ID Generation:**

```python
point_id = str(uuid.UUID(hashlib.md5(chunk_id.encode()).hexdigest()))
```

Deterministic: re-ingesting the same chunk produces the same UUID, enabling idempotent upserts.

---

## 11. Configuration & Constants

### Environment / Hardcoded Values

| Setting | Value | Location |
|---------|-------|----------|
| Qdrant URL | `http://localhost:6333` | `search.py`, `ingest.py` |
| Qdrant collection | `academic_articles` | throughout |
| BGE-M3 model | `BAAI/bge-m3` | `embedder.py` |
| Dense vector size | 1024 | `ingest.py` |
| Embedding batch size | 32 | `embedder.py` |
| Max token length | 8192 | `embedder.py` |
| PDF render DPI | 200 | `main.py` |
| WebP quality | 85 | `main.py` |
| Page image cache TTL | 86400s (24h) | `main.py` (Cache-Control) |
| Chunk target tokens | 400 (~1600 chars) | `chunker.py` |
| Chunk min chars | 400 | `chunker.py` |
| Chunk max chars | 2400 | `chunker.py` |
| Chunk overlap | 10% (160 chars) | `chunker.py` |
| Upsert batch size | 100 | `ingest.py` |
| Pipeline queue size | 4 | `ingest.py` |
| HNSW m | 16 | `ingest.py` |
| HNSW ef_construct | 256 | `ingest.py` |
| Indexing threshold | 20000 | `ingest.py` |

### CORS

Configured to allow **all origins** (`allow_origins=["*"]`). This is suitable for development but should be restricted in production.

---

## 12. CLI Reference

### Ingest documents

```bash
# Activate virtual environment
source .venv/bin/activate

# Ingest all documents (resume from checkpoint)
python -m pipeline.ingest --input-dir output/ --collection academic_articles

# Recreate collection from scratch
python -m pipeline.ingest --input-dir output/ --collection academic_articles --recreate
```

### Search from command line

```bash
python -m pipeline.search --query "البحث العلمي" --top-k 10 --mode hybrid

# With filters
python -m pipeline.search --query "التعليم" --journal-id 0005 --mode dense
```

### Validate chunker

```bash
python -m pipeline.test_chunker
```

### Start API server

```bash
uvicorn api.main:app --host 0.0.0.0 --port 8000 --reload
```

### Start Qdrant

```bash
./qdrant
```
