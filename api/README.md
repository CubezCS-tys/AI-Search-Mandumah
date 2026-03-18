# api/

FastAPI application. Thin HTTP layer that delegates to `services/` and serves static document assets.

---

## Running

Always use the venv interpreter:

```bash
# from project root
.venv/bin/uvicorn api.main:app --host 0.0.0.0 --port 8000 --reload
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `QDRANT_URL` | `http://localhost:6333` | Qdrant server address |
| `COLLECTION_NAME` | `academic_articles` | Qdrant collection to query |
| `OUTPUT_DIR` | `<project_root>/output` | Root directory of Azure DI output files |
| `OPENAI_API_KEY` | — | Required for `/api/chat` |
| `API_KEY` | _(unset)_ | If set, all requests must include `X-API-Key: <value>` |

---

## Middleware

### CORS
Allowed origins: `http://localhost:3000` and `http://127.0.0.1:3000`.

### API key guard
If `API_KEY` is set, every request must carry the matching `X-API-Key` header, otherwise the server returns `401 Unauthorized`.

---

## Endpoints

### `GET /api/health`

Checks Qdrant connectivity.

**Response:**
```json
{
  "status": "ok",
  "collection": "academic_articles",
  "points_count": 4200
}
```

Returns `{"status": "error", "detail": "..."}` if Qdrant is unreachable.

---

### `POST /api/search`

Hybrid/dense/sparse vector search.

**Request:**
```json
{
  "query": "أثر التعليم الإلكتروني",
  "top_k": 10,
  "mode": "hybrid",
  "journal_id": null,
  "section": null,
  "doc_id": null
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `query` | `str` | required | |
| `top_k` | `int` | `10` | Capped at 100 |
| `mode` | `str` | `"hybrid"` | `"hybrid"` / `"dense"` / `"sparse"` |
| `journal_id` | `str?` | `null` | Filter to a single journal |
| `section` | `str?` | `null` | Filter to a section name |
| `doc_id` | `str?` | `null` | Filter to a single document |

**Response:**
```json
{
  "query": "...",
  "mode": "hybrid",
  "total": 10,
  "search_ms": 42.3,
  "results": [
    {
      "chunk_id": "0005-076-002-001_chunk_3",
      "doc_id": "0005-076-002-001",
      "journal_id": "0005",
      "title": "عنوان المقال",
      "section": "المقدمة",
      "text": "...",
      "score": 0.842,
      "chunk_index": 3,
      "char_len": 1540
    }
  ]
}
```

---

### `GET /api/pdf/{doc_id}`

Serves the original PDF.

- Resolves to `OUTPUT_DIR/output_{journal_id}/{doc_id}/{doc_id}.pdf`
- Returns `application/pdf`
- `404` if not found, `400` if `doc_id` format is invalid

---

### `GET /api/document/{doc_id}/ocr`

Returns the Azure DI JSON for a document, with raster pixel dimensions injected per page.

The raster dimensions are computed from the PDF page size at 200 DPI (`px = inches × 200 / 72 × 72 = inches × 200`) and injected as `rasterWidth` / `rasterHeight` on each page object. These match the dimensions of the images returned by the image endpoint.

**Response:** `{ "pages": [ { "pageNumber", "width", "height", "unit", "angle", "rasterWidth", "rasterHeight", "words", "lines" }, ... ] }`

This is an async endpoint — file I/O runs in a thread via `asyncio.to_thread`.

---

### `GET /api/document/{doc_id}/page/{page_num}/image`

Renders a PDF page as WebP at 200 DPI.

- Results are cached in an LRU cache (max 200 entries) keyed by `{doc_id}:{page_num}`
- Rendering runs in a thread via `asyncio.to_thread` so the event loop is never blocked
- Returns `image/webp` with `Cache-Control: public, max-age=86400` and `ETag`

---

### `POST /api/chat`

Streams a GPT-4o-mini response grounded in one or more documents. When `compare_doc_ids` is provided the endpoint enters **multi-document comparison mode** and dispatches to `services.chat.stream_chat_multi`.

**Request:**
```json
{
  "doc_id": "0005-076-002-001",
  "message": "ما هي النتائج الرئيسية؟",
  "history": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "compare_doc_ids": []
}
```

| Field | Constraint | Description |
|---|---|---|
| `doc_id` | `^\d{4}-\d{3}-\d{3}-\d{3}$` | Primary document |
| `message` | Non-empty, max 10,000 chars | The user's question |
| `history[].role` | `"user"` or `"assistant"` only (Literal) | Rejects `"system"` injection |
| `history` | Max 40 entries | |
| `content` (in history) | Max 100,000 chars per message | |
| `compare_doc_ids` | Max 3 IDs, same format as `doc_id` | Optional comparison documents |

**Multi-doc mode** is activated when `compare_doc_ids` is non-empty. The endpoint:
1. Loads the primary document and each comparison document (duplicates skipped).
2. Calls `stream_chat_multi` which splits `MAX_CONTENT_CHARS` (400,000) evenly across all documents.
3. Labels documents `المستند 1 (الأساسي)`, `المستند 2`, `المستند 3`, … in the system prompt.

**Response:** `text/event-stream` (SSE)

Each event: `data: {"token": "..."}\n\n`  
Final event: `data: [DONE]\n\n`  
On error: `data: {"error": "..."}\n\n`

---

## Implementation notes

- **Searcher singleton** uses double-checked locking (`threading.Lock`) to prevent concurrent cold-start races from loading BGE-M3 twice.
- **Page image cache** is an `OrderedDict`-backed LRU with a hard cap of 200 rendered pages, keyed by `{doc_id}:{page_num}`.
- **Document content cache** is a second `OrderedDict`-backed LRU (max 50 entries) that avoids re-reading JSON on every chat turn.
- **All file I/O** in async endpoints is offloaded via `asyncio.to_thread` to avoid blocking the event loop.
- **Path resolution** uses `Path(__file__).parent.parent / "output"` so the server works regardless of the working directory.
