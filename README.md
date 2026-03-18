# AI-Search-Mandumah

Arabic academic document search and chat platform, built on top of the [Mandumah](https://www.mandumah.com/) journal corpus.

---

## What it does

- **Full-text hybrid search** over Arabic academic articles using BGE-M3 dense + sparse vectors with Reciprocal Rank Fusion
- **Document viewer** with word-level OCR overlay sourced from Azure Document Intelligence
- **Document-scoped chat** powered by GPT-4o-mini, grounded in the full text of a single article

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, Tailwind v4, SWR |
| API server | FastAPI + Uvicorn |
| Vector database | Qdrant (local) |
| Embedding model | BGE-M3 (`BAAI/bge-m3`) via FlagEmbedding |
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
```

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
Azure DI JSON → Chunker → BGE-M3 Embedder → Qdrant upsert
```

**Search** (per request):
```
Query → BGE-M3 encode → Qdrant hybrid search (RRF) → Results
```

**Document view + chat** (per request):
```
doc_id → PDF / OCR JSON / page images → viewer
doc_id + message → full document text → GPT-4o-mini stream → SSE
```
