# services/

Business logic layer sitting between the API and external dependencies (Qdrant, OpenAI). Both modules are designed for lazy initialisation — no heavy resources are loaded until the first request.

---

## search.py

Hybrid vector search over the Qdrant collection using BGE-M3 embeddings.

### How the three modes work

| Mode | Vectors used | Best for |
|---|---|---|
| `hybrid` | Dense + sparse, fused with RRF | Default; best overall quality |
| `dense` | 1024-d float (semantic similarity) | Conceptual / paraphrase queries |
| `sparse` | Learned lexical weights (BGE-M3) | Exact terms, names, acronyms |

**Hybrid mode** runs both dense and sparse as Qdrant `Prefetch` queries (`prefetch_k = top_k × 3` results each), then fuses the two ranked lists on the Qdrant server using **Reciprocal Rank Fusion**:

$$\text{RRF}(d) = \sum_{r} \frac{1}{60 + \text{rank}_r(d)}$$

RRF is scale-invariant — it works even when dense cosine scores and sparse dot-product scores are on completely different scales.

### Class: `Searcher`

```python
from backend.services.search import Searcher

searcher = Searcher(
    qdrant_url="http://localhost:6333",
    collection_name="academic_articles",
)

results = searcher.search(
    "أثر التعلم الإلكتروني على التحصيل الدراسي",
    top_k=10,
    mode="hybrid",
    journal_id="0005",   # optional filter
    section=None,
    doc_id=None,
)

for r in results:
    print(f"{r.score:.4f}  [{r.doc_id}]  {r.text[:80]}")
```

`BGEm3Embedder` is lazy-loaded on first call to `search()`.

### `SearchResult` fields

| Field | Type | Description |
|---|---|---|
| `chunk_id` | `str` | `{doc_id}_chunk_{n}` |
| `doc_id` | `str` | Parent document ID |
| `journal_id` | `str` | First 4 chars of doc_id |
| `title` | `str` | Document title |
| `section` | `str` | Section the chunk belongs to |
| `text` | `str` | Chunk text |
| `score` | `float` | RRF / cosine / dot-product score |
| `chunk_index` | `int` | Position of chunk within document |
| `char_len` | `int` | Character length of chunk |

### CLI

```bash
python -m services.search --query "البحث العلمي" --top-k 5 --mode hybrid

# With filters
python -m services.search -q "التعليم" --journal 0005 --mode dense --verbose
```

---

## chat.py

Document-scoped chat using GPT-4o-mini. Takes the full text of one or more articles, stuffs it into a system prompt, and streams tokens back as SSE.

### Behaviour

- The system prompt instructs the model to answer only from the provided document text, cite passages using Arabic guillemets («»), reference sections by name, and respond in the same language the user writes in.
- Documents longer than `MAX_CONTENT_CHARS` (400,000 characters ≈ 100K tokens) are truncated with an Arabic notice so the model's context window is never exceeded.
- In **multi-document mode**, `MAX_CONTENT_CHARS` is split evenly across all documents (primary + comparisons), so each document gets a fair character budget regardless of count.
- History is capped at the most recent `MAX_HISTORY` (40) turns before being sent to the API.
- The OpenAI client is lazy-loaded on first call and cached as a module-level singleton.

### `stream_chat`

```python
from services.chat import stream_chat

for event in stream_chat(document_text, message, history):
    print(event, end="")
# yields: "data: {"token": "..."}\n\n" ... "data: [DONE]\n\n"
```

| Parameter | Type | Description |
|---|---|---|
| `document_text` | `str` | Full `content` field from the Azure DI JSON |
| `message` | `str` | The new user message |
| `history` | `list[dict]` | Previous turns: `[{"role": "user"\|"assistant", "content": "..."}]` |

Yields SSE-formatted strings. On any OpenAI API error, yields `data: {"error": "..."}` and stops.

### `stream_chat_multi`

```python
from backend.services.chat import stream_chat_multi

for event in stream_chat_multi(primary_text, compare_docs, message, history):
    print(event, end="")
```

| Parameter | Type | Description |
|---|---|---|
| `primary_text` | `str` | Full text of the primary document |
| `compare_docs` | `list[tuple[str, str]]` | List of `(doc_id, content)` for comparison documents (max 3) |
| `message` | `str` | The new user message |
| `history` | `list[dict]` | Previous turns |

Uses `MULTI_DOC_SYSTEM_PROMPT` which instructs the model to attribute quotes to specific documents using `(المستند 1)` / `(المستند 2)` notation. Each document is introduced with a `### المستند N` heading; the primary document is labelled `(الأساسي)`.

The character budget per document is `MAX_CONTENT_CHARS // total_docs`. Truncated documents get an `[... تم اختصار المستند ...]` Arabic suffix.

### Model parameters

| Parameter | Value |
|---|---|
| Model | `gpt-4o-mini` |
| Temperature | `0.3` |
| Max output tokens | `16384` |
| Stream | `True` |

### Environment variable

`OPENAI_API_KEY` must be set (loaded via `.env` at startup). The service raises `RuntimeError` on first call if the key is missing.
