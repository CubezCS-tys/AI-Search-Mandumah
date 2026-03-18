# pipeline/

Offline ingestion tools: chunker, embedder, and the three-stage ingestion pipeline. Run once to populate the Qdrant collection; not involved in live search or chat.

---

## Modules

| File | Purpose |
|---|---|
| `chunker.py` | Splits Azure DI document text into retrieval-optimised chunks |
| `embedder.py` | BGE-M3 wrapper producing dense + sparse vectors |
| `ingest.py` | Three-stage pipelined ingestion CLI |
| `test_chunker.py` | Chunker validation and statistics script |

---

## chunker.py

Structure-aware chunker for Arabic academic documents. Takes the raw `content` string from an Azure DI JSON file and returns a list of `Chunk` objects.

### Sizing constants

| Constant | Value | Notes |
|---|---|---|
| `TARGET_CHARS` | 1600 | ≈ 400 Arabic tokens |
| `MIN_CHARS` | 400 | Chunks smaller than this are merged |
| `MAX_CHARS` | 2400 | Hard ceiling; forces a split |
| `OVERLAP_CHARS` | 160 | ~10% overlap carried into the next chunk |

### Processing phases

**Phase 1 — Line cleaning**
- Strips page numbers (pure digit lines)
- Strips journal/ISSN/DOI boilerplate
- Strips author lines (email patterns, institutional affiliations)
- Detects reference/bibliography section headers (`المراجع`, `References`, etc.) and discards everything after them
- Identifies section headers (`المقدمة`, `النتائج`, numbered headings, etc.) and stores them as the current section label without including them in chunk text

**Phase 2 — Chunk building**
- Accumulates cleaned lines into a buffer
- Flushes at sentence boundaries (`.` `؟` `!` `؛` or `\n\n`) when the buffer exceeds `TARGET_CHARS`
- Flushes immediately on section change
- Carries `OVERLAP_CHARS` from the end of each chunk into the beginning of the next

**Phase 3 — Post-processing**
- Merges any chunk below `MIN_CHARS` with its smaller neighbour

### Chunk data class

```python
@dataclass
class Chunk:
    chunk_id: str       # "{doc_id}_chunk_{n:03d}"
    doc_id: str
    text: str           # Raw chunk text (stored in Qdrant payload)
    embed_text: str     # "{title}\n{section}\n{text}" — fed to BGE-M3
    section: str        # Detected section label, or "" for body text
    char_len: int
    chunk_index: int
    page_start: int | None
```

### Usage

```python
from pipeline.chunker import chunk_document

result = chunk_document(content, doc_id="0005-076-002-001")
for chunk in result.chunks:
    print(chunk.chunk_id, chunk.section, len(chunk.text))
```

---

## embedder.py

Wraps `BAAI/bge-m3` via the FlagEmbedding library. Produces dense (1024-d float) and sparse (learned lexical weights) vectors from a single forward pass.

### Configuration

| Parameter | Default |
|---|---|
| `model_name` | `"BAAI/bge-m3"` |
| `batch_size` | `32` |
| `max_length` | `8192` tokens |
| `use_fp16` | `True` |

Model loading is deferred to the first `encode()` call. The loaded model is cached on the instance.

### Embedding result

```python
@dataclass
class EmbeddingResult:
    dense: list[float]          # 1024 dimensions
    sparse_indices: list[int]   # Non-zero token IDs
    sparse_values: list[float]  # Corresponding IDF-weighted values
```

### Usage

```python
from pipeline.embedder import BGEm3Embedder

embedder = BGEm3Embedder()
results = embedder.encode(["النص الأول", "النص الثاني"])
print(results[0].dense[:5])          # [-0.012, 0.034, ...]
print(results[0].sparse_indices[:5]) # [142, 891, ...]
```

---

## ingest.py

Three-stage pipelined ingestion. Chunking, embedding, and upserting run concurrently on separate threads so that GPU time (embedding) overlaps with disk I/O (reading JSON) and network I/O (Qdrant upserts).

### Architecture

```
[Chunker thread]  --Queue(4)-->  [Embedder thread]  --Queue(4)-->  [Upserter thread]
  Read JSON                        BGE-M3 encode                    Qdrant upsert
  chunk_document()                 batches of 32                    sub-batches of 100
```

Bounded queues (size 4) prevent memory overflow when the embedder is the bottleneck.

### Checkpoint / resume

Progress is saved to `output/ingest_checkpoint.json` after each document is successfully upserted:

```json
{
  "processed": ["0005-076-002-001", "0005-076-002-002"],
  "failed": [],
  "stats": {}
}
```

Re-running the pipeline skips already-processed documents. Use `--no-resume` to ignore the checkpoint.

### Qdrant collection schema

Created automatically on first run if the collection does not exist.

**Dense vector:** 1024d, Cosine distance, on-disk storage, HNSW `m=16` / `ef_construct=256`, INT8 scalar quantization.  
**Sparse vector:** IDF modifier.  
**Payload indexes:** `doc_id` (keyword), `journal_id` (keyword), `section` (keyword), `title` (text).

**Point ID:** `md5(chunk_id)` as a hex string — deterministic and idempotent. Re-ingesting the same document overwrites existing points without creating duplicates.

### CLI

```bash
# Ingest all documents (resumes from checkpoint)
python -m pipeline.ingest --input-dir output/

# Full options
python -m pipeline.ingest \
  --input-dir output/ \
  --collection academic_articles \
  --batch-size 32 \
  --no-resume \
  --dry-run \
  --limit 10
```

| Flag | Default | Description |
|---|---|---|
| `--input-dir` | required | Root of the `output/` directory |
| `--collection` | `academic_articles` | Qdrant collection name |
| `--batch-size` | `32` | Embedding batch size |
| `--no-resume` | off | Ignore checkpoint; reprocess everything |
| `--dry-run` | off | Chunk and embed but do not write to Qdrant |
| `--limit N` | off | Stop after N documents (useful for testing) |

---

## test_chunker.py

Runs the chunker over every document in `output/` and prints aggregate statistics. Not a unit test framework; use it to validate chunking quality after changing constants.

```bash
python -m pipeline.test_chunker
```

Output includes: document count, total chunks, average chunks per document, chunk size distribution histogram, total reference chars skipped, and any errors (empty chunks, exceptions).
