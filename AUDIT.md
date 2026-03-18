# Architecture Audit — AI-Search-Mandumah

> Audited: March 17, 2026

---

## What's Right ✓

### Backend / Pipeline

1. **Lazy model loading** — BGE-M3 (~2 GB) and the OpenAI client are both deferred to first use. The server starts instantly without loading heavy models at import time.

2. **3-stage pipelined ingestion** — Chunker → Embedder → Upserter run on three independent threads with bounded queues (size 4). CPU/IO, GPU, and network all overlap concurrently.

3. **Idempotent ingestion with checkpointing** — Point IDs are deterministic (`md5(chunk_id)`), so re-running never creates duplicates. `ingest_checkpoint.json` tracks processed/failed doc IDs for safe resume.

4. **Hybrid search via server-side RRF** — Qdrant RRF fusion is offloaded to the database engine. No manual score merging in Python; the client just fires prefetch queries.

5. **BGE-M3 for Arabic** — Correct model choice: multilingual, handles Arabic morphology, produces dense + sparse in one forward pass.

6. **`doc_id` regex validation** — `_DOC_ID_RE` (`^\d{4}-\d{3}-\d{3}-\d{3}$`) applied before every file path construction in `/api/pdf`, `/api/document`, and `/api/chat`. Prevents path traversal attacks.

7. **ETag + Cache-Control on page images** — `ETag` header and `max-age=86400` mean the browser won't re-fetch rendered pages. Correctly derived from a content hash.

8. **INT8 scalar quantization + on-disk HNSW** — Memory-efficient Qdrant config (`m=16`, `ef_construct=256`, `quantile=0.99`). Payload indexes on `doc_id`, `journal_id`, `section`, and `title`.

9. **CORS restricted to localhost** — Not `allow_origins=["*"]`. Correctly locked to `localhost:3000` and `127.0.0.1:3000`.

10. **Streaming SSE with generator error handling** — `services/chat.py` has a try/except inside the generator that yields `data: {"error": "..."}` on failure rather than silently dying mid-stream.

11. **Section-aware chunking with Arabic boilerplate detection** — Strips journal headers, ISSN/DOI lines, author lines, page numbers, and full reference sections before chunking. `embed_text` prepends `title + section` for richer embeddings.

12. **`.env` is gitignored** — `.gitignore` correctly excludes `.env`, `.env.local`, `output/`, `storage/`, and `.venv/`.

### Frontend

13. **Prefetch optimization** — The home page fires the real API call during the animation sequence and stashes the result in a module-level cache (`_prefetched`). The `/search` page consumes it as SWR `fallbackData`, so results appear instantly with no skeleton flash.

14. **URL-synced search state** — Query, mode, and all filters are reflected in URL params. Back button, sharing, and browser history all work correctly.

15. **SWR with `revalidateOnFocus: false`** — Prevents result flicker every time the user switches windows. Correct for a search UX.

16. **AbortController on chat streams** — `ChatPanel` creates an `AbortController` on each request and exposes a cancel path, preventing stale stream continuations on re-send.

17. **Word-level OCR overlay** — `DocumentViewer` uses actual Azure DI polygon coordinates with a `polygonToRect` helper that correctly accounts for the raster scale (`200/72` DPI transform). Tashkeel-stripped search matching is correct for Arabic.

---

## What's Wrong ✗

### Critical Bugs

**1. Wrong Python environment causes boot crash**
`openai`, `qdrant-client`, `PyMuPDF`, and `FlagEmbedding` are all installed in `.venv`, but if the server is launched with the system Python (plain `uvicorn` instead of `.venv/bin/uvicorn`) the result is the `ModuleNotFoundError: No module named 'openai'` visible in the server logs. There is no `requirements.txt`, `pyproject.toml`, or `Makefile` to make the correct launch command obvious to a new developer.

**2. `EmbeddingAnimation` is imported but never rendered**
`frontend/src/app/page.tsx` line 11 imports `EmbeddingAnimation`; it appears nowhere in the JSX. Dead import.

---

### Security

**3. `ChatMessage.role` is unvalidated — prompt injection vector**
```python
class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
```
`role` accepts any string including `"system"`. A client can send a history entry with `role: "system"` and inject a forged system message into the OpenAI messages array with elevated trust. Should be `role: Literal["user", "assistant"]`.

**4. No authentication on any endpoint**
`/api/chat` proxies every request to OpenAI at the owner's expense. Anyone who can reach port 8000 can burn API credits freely. There is no API key header, session token, IP allowlist, or rate limiting on any endpoint.

**5. `top_k` has no upper bound**
```python
top_k: int = 10
```
A client can send `top_k=100000`. Qdrant will attempt to satisfy it; the search will be very slow at best and cause an OOM at worst. Should be `Field(default=10, ge=1, le=100)`.

**6. No history length limit on chat**
`history: list[ChatMessage] = []` is unbounded. A client can send a 500-turn history, creating a massive and expensive OpenAI API request at the server's cost.

---

### Architecture

**7. Unbounded in-memory page image cache**
```python
_page_image_cache: dict[str, tuple[bytes, str]] = {}
```
Grows forever. At 200 DPI a rendered A4 WebP is 150–500 KB. With 400+ articles this will silently exhaust RAM. Needs an LRU eviction policy (e.g. `cachetools.LRUCache` or `functools.lru_cache`).

**8. Blocking synchronous I/O inside async endpoints**
`get_ocr()`, `get_page_image()`, and `chat()` all call `open()`, `json.load()`, `fitz.open()`, and `page.get_pixmap()` directly inside `async def` handlers. These are blocking calls that hold the entire uvicorn event loop while reading from disk or rendering a page. Under concurrent requests this serializes all processing. Should be wrapped in `asyncio.to_thread(...)`.

**9. Non-thread-safe searcher singleton**
```python
def get_searcher():
    global _searcher
    if _searcher is None:          # <- race condition
        _searcher = Searcher(...)
```
Two concurrent cold-start requests can both enter the branch simultaneously, triggering a double BGE-M3 model load. Should use `threading.Lock` or initialize at application startup via a FastAPI `lifespan` handler.

**10. Full document stuffed into system prompt with no truncation**
`/api/chat` reads the full `content` field from the Azure DI JSON and passes the raw string directly to `stream_chat`. A 20-page Arabic academic paper can easily be 80,000–150,000 characters (~20K–40K tokens). After adding the system prompt, history, and the user message, this can silently exceed GPT-4o-mini's 128K context limit. No truncation, no warning, and no feedback is given to the user.

**11. Hard-coded CWD-relative paths**
All file access uses `os.path.join("output", ...)` relative to the current working directory. The server must be launched from the project root specifically, or all file lookups silently return 404. Should use `pathlib.Path(__file__).parent.parent / "output"` or an `OUTPUT_DIR` environment variable.

**12. No `requirements.txt` or `pyproject.toml`**
The project has no formal Python dependency specification. The `.venv` is the only record of what is installed. Reproducing the environment on a new machine requires trial and error. Add at minimum a `requirements.txt` via `pip freeze > requirements.txt`.

---

### Minor

**13. `react-pdf` in `package.json` but never imported**
`DocumentViewer.tsx` implements a custom image + OCR overlay approach and never imports `react-pdf`. The package (and the `public/pdf.worker.min.js` / `public/pdf.worker.min.mjs` worker files) are dead weight in the bundle and should be removed.

**14. `legacy.md` in the project root**
Unclear if this is live documentation or stale reference material. Should be archived or deleted.

**15. Windows `.Zone.Identifier` files in `output/`**
Files like `metrics.txt:Zone.Identifier` are scattered throughout the output directories. The ingestion pipeline correctly skips non-`.json` files, so they are harmless, but they pollute the directory structure. Can be cleaned with:
```bash
find output/ -name '*:Zone.Identifier' -delete
```

**16. `EmbeddingAnimation` vs `SonarPulseAnimation` ambiguity**
Both components animate the "query being embedded" concept. Only `SonarPulseAnimation` is rendered. `EmbeddingAnimation` is either an obsolete first-draft or a planned replacement that was never wired up. Either delete it or finish the integration.

**17. No structured logging / request ID correlation**
`logger` is used throughout the services but there is no request ID propagated between the API layer and service calls. When debugging a failed `/api/chat` request it is impossible to correlate which log lines belong to which request. A FastAPI middleware that injects a `X-Request-ID` header and adds it to a `contextvars.ContextVar` would solve this.

---

## Summary

| Area | Rating | Key Issue |
|---|---|---|
| Search quality | ✅ Good | BGE-M3 hybrid, server-side RRF |
| Ingestion pipeline | ✅ Good | Pipelined, checkpointed, idempotent |
| Security | ⚠️ Weak | No auth, unvalidated `role` field, no rate limiting |
| Async correctness | ❌ Bad | Blocking I/O in every async handler |
| Memory management | ❌ Bad | Unbounded page image cache |
| Dependency management | ❌ Bad | No requirements.txt; wrong venv causes boot crash |
| Frontend UX | ✅ Good | Prefetch, URL-sync, streaming, OCR overlay |
| Dead code | ⚠️ Minor | `EmbeddingAnimation`, `react-pdf` |
