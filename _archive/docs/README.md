# AI-Search-Mandumah

Arabic academic document search and chat platform, built on top of the [Mandumah](https://www.mandumah.com/) journal corpus.

---

## What it does

- **Full-text hybrid search** over Arabic academic articles using OpenAI `text-embedding-3-small` dense vectors + TF-IDF sparse vectors with Reciprocal Rank Fusion
- **Document viewer** with word-level OCR overlay sourced from Azure Document Intelligence
- **Document-scoped chat** powered by GPT-4o-mini, grounded in the full text of a single article

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, Tailwind v4, SWR |
| API server | FastAPI + Uvicorn |
| Vector database | Qdrant (local) |
| Embedding model | OpenAI `text-embedding-3-small` (1536-d dense) + hashed TF-IDF sparse |
| OCR source | Azure Document Intelligence |
| Chat model | GPT-4o-mini (OpenAI) |
| PDF rendering | PyMuPDF (fitz) |

---

## Repository layout

```
.
├── backend/        Python backend
│   ├── main.py     FastAPI application
│   ├── services/   Search, chat, HyDE, synthesis
│   └── pipeline/   Chunker, embedder, ingestion CLI
├── frontend/       Next.js application → see frontend/README.md
├── output/         Azure DI JSON + PDF files (gitignored)
├── storage/        Qdrant on-disk storage (gitignored)
├── qdrant          Qdrant binary
└── requirements.txt Python dependencies
```

---

## Quick start

### 1. Dependencies

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

```bash
cd frontend && npm install
```

### 2. Environment variables

Create a `.env` file in the project root:

```env
OPENAI_API_KEY=sk-...

# Optional overrides (defaults shown)
QDRANT_URL=http://localhost:6333
COLLECTION_NAME=academic_articles
OUTPUT_DIR=./output

# Optional: lock the API behind a key
# API_KEY=your-secret-key

# ── Admin / Vector Console (/admin) ──────────────────────────────
# Username/password for the read-only corpus & vector inspector.
# CHANGE THESE before exposing the port publicly.
ADMIN_USER=admin
ADMIN_PASSWORD=change-me
# Optional: explicit token-signing secret. If omitted, it is derived from
# ADMIN_PASSWORD (so changing the password invalidates old sessions).
# ADMIN_SECRET=some-long-random-string
# Optional: session lifetime in seconds (default 43200 = 12h)
# ADMIN_TOKEN_TTL=43200
```

> The `QDRANT_URL` above is read by both the search API and the admin console,
> so pointing it at a **remote** Qdrant (e.g. a bare-metal box) works with no
> code changes.

### 3. Start Qdrant

```bash
./qdrant
```

### 4. Ingest documents

```bash
python -m backend.pipeline.ingest --input-dir output/
```

See [pipeline/README.md](pipeline/README.md) for full options.

### 5. Start the API server

```bash
.venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

> **Note:** always use `.venv/bin/uvicorn`, not the system `uvicorn`, so the correct packages are used.

### 6. Start the frontend

```bash
cd frontend && npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Admin / Vector Console

A read-only operator console for inspecting the live Qdrant collection — browse
documents, drill into chunks and their dense + sparse vectors, debug retrieval,
and visualize the vector space.

- **URL:** `http://<host>:3000/admin` (sign in with `ADMIN_USER` / `ADMIN_PASSWORD`)
- **API:** `/api/admin/*` on the backend, gated by its own username/password
  (HMAC-signed bearer token — independent of the optional corpus `API_KEY`).

**Features**

| Page | What it shows |
|---|---|
| **Overview** | Collection switcher, doc/chunk counts, vector config (dim, distance, quantization, HNSW), chunk-length histogram, journal & section breakdowns |
| **Documents** | Paginated, filterable list of unique documents → all chunks of a document in reading order |
| **Chunk inspector** | Full payload + text, the dense vector (norm + per-dim strip), the sparse vector (top weighted terms), and nearest-neighbour chunks |
| **Explore** | Retrieval debugger (dense vs sparse vs hybrid side by side) and a 2-D PCA **vector map** colored by journal/section/year |

> Because it talks to the backend (which reads `QDRANT_URL`), it works against a
> remote bare-metal Qdrant unchanged. Set a strong `ADMIN_PASSWORD` (and ideally
> `ADMIN_SECRET`) before opening the port to the internet.

---

## Document ID format

All document IDs follow the pattern `JJJJ-VVV-III-AAA`:

| Segment | Meaning | Example |
|---|---|---|
| `JJJJ` | Journal ID | `0005` |
| `VVV` | Volume | `076` |
| `III` | Issue | `002` |
| `AAA` | Article number | `003` |

The journal ID is always the first 4 characters.

---

## Data flow

**Ingestion** (offline, run once):
```
Azure DI JSON → Chunker → OpenAI Embedder (async) → Qdrant upsert
```

**Search** (per request):
```
Query → OpenAI encode → Qdrant hybrid search (RRF) → Results
```

**Document view + chat** (per request):
```
doc_id → PDF / OCR JSON / page images → viewer
doc_id + message → full document text → GPT-4o-mini stream → SSE
```

---

## MCP server (Streamable HTTP)

The same FastAPI process exposes a [Model Context Protocol](https://modelcontextprotocol.io/)
server at `POST /mcp`, letting any MCP-capable client (Claude, Copilot Studio, MCP Inspector)
query the Mandumah corpus through 4 retrieval-only tools:

| Tool | Description |
|---|---|
| `search_articles` | Hybrid search; returns ranked passages with metadata |
| `get_article` | Full text of a specific article (pageable) |
| `get_article_passages` | Passage-level search within one article |
| `get_corpus_overview` | Collection stats (document + chunk counts) |

### How to use

The MCP server is enabled by default. Set `MCP_ENABLED=false` to disable it entirely.

```bash
# Canonical MCP endpoint (note trailing slash)
POST /mcp/

# Or: POST /mcp → 307 redirect → /mcp/ (clients that follow redirects work fine)
```

**Required env vars** (same as the main API):
```env
OPENAI_API_KEY=sk-...
QDRANT_URL=http://localhost:6333
PUBLIC_BASE_URL=https://your-public-host   # used in pdf_url links
```

**Optional:**
```env
API_KEY=...          # when set, require X-API-Key header on all routes including /mcp
MCP_ENABLED=false    # disables /mcp entirely (no import, no route)
```

### Quick smoke test (MCP Inspector)

With the server running and Qdrant up:
```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP
# URL: http://localhost:8000/mcp
# Header: X-API-Key: <key>   (if API_KEY is set)
```

### Running the test suite

```bash
# Unit + protocol tests (no Qdrant needed)
source .venv/bin/activate
pytest backend/tests/ -m unit -v

# Integration tests (requires live Qdrant + OPENAI_API_KEY)
pytest backend/tests/ -m integration -v

# Performance benchmark (manual, prints latency table)
python backend/tests/perf_mcp.py
```

### Copilot Studio setup

See [docs/MCP_COPILOT_STUDIO_SETUP.md](docs/MCP_COPILOT_STUDIO_SETUP.md) for
click-by-click instructions to attach the server to a Copilot Studio agent.

