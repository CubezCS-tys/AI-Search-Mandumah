# المنظومة - المساعد الذكي: Complete System Architecture Analysis

> **Purpose**: Full architectural deep-dive for planning a system rebuild.
> **Generated**: March 15, 2026

---

## Table of Contents

1. [Full Tech Stack](#1-full-tech-stack)
2. [Deployment & Infrastructure](#2-deployment--infrastructure)
3. [API Structure & Endpoints](#3-api-structure--endpoints)
4. [Search Pipeline (End-to-End)](#4-search-pipeline-end-to-end)
5. [Document Chunking & Embedding](#5-document-chunking--embedding)
6. [Vector Database (Qdrant)](#6-vector-database-qdrant)
7. [Hybrid Search & Reranking](#7-hybrid-search--reranking)
8. [The 4 Search Modes](#8-the-4-search-modes)
9. [Document Ingestion Pipeline](#9-document-ingestion-pipeline)
10. [Metadata Per Document/Chunk](#10-metadata-per-documentchunk)
11. [Document Viewer & Passage Highlighting](#11-document-viewer--passage-highlighting)
12. [Citation & Reference System](#12-citation--reference-system)
13. [Document Analysis Panel](#13-document-analysis-panel)
14. [Filters](#14-filters)
15. [Authentication Model](#15-authentication-model)
16. [User Roles & Permissions](#16-user-roles--permissions)
17. [Admin Dashboard](#17-admin-dashboard)
18. [Data Scale](#18-data-scale)
19. [Relationship with Mandumah](#19-relationship-with-mandumah)
20. [Pain Points & Technical Debt](#20-pain-points--technical-debt)

---

## 1. Full Tech Stack

| Layer | Technology | Details |
|-------|-----------|---------|
| **Backend Framework** | FastAPI (Python) | `fastapi==0.116.1`, `starlette==0.47.1`, served by Gunicorn (`gunicorn==23.0.0`) |
| **Frontend Framework** | Next.js (React, TypeScript) | `next`, `react`, `axios`, `lucide-react`, `react-markdown` |
| **Admin Dashboard** | Next.js (React, TypeScript) | `recharts`, `plotly`, `@tanstack/react-table`, `tailwindcss` |
| **VDB Manager** | Vite + React (JSX) | Lightweight tool on port 3002 |
| **Vector Database** | Qdrant | `qdrant-client==1.15.1`, remote server at `52.117.200.185:6333` |
| **Legacy Vector Index** | FAISS | `faiss-cpu==1.11.0.post1` (still in deps, migrated to Qdrant) |
| **Embedding Model** | OpenAI `text-embedding-3-small` | 1536 dimensions, $0.00002/1K tokens |
| **QA/Chat LLM** | OpenAI `gpt-4o-mini-2024-07-18` | temperature=0, $0.00015/$0.0006 per 1K tokens |
| **Literature Review LLM** | Google `gemini-2.5-flash` | 1M token context window, $0.000125/$0.000375 per 1K tokens |
| **Translation LLM** | OpenAI `gpt-4o-mini-2024-07-18` | Same model as QA |
| **Relational Database** | MySQL | `PyMySQL==1.1.2`, connection pool size 10 |
| **Session Cache (Auth)** | Memcache | `pymemcache==4.0.0`, server at `10.220.8.189:11213` |
| **Session Cache (AI)** | Redis | `redis==7.1.0`, local `localhost:6379` |
| **Object Storage** | AWS S3 | `boto3==1.39.6`, bucket `cubez-ai-rag-data`, region `eu-west-2` |
| **Reverse Proxy** | Nginx | SSL termination, routing, basic auth for admin |
| **Observability** | Prometheus + Grafana + Loki + Promtail | Full metrics/logging/dashboards stack |
| **Rate Limiting** | SlowAPI | `slowapi==0.1.9` |
| **Data Validation** | Pydantic v2 | `pydantic==2.11.7` |

### Key Python Dependencies (100+ packages)

- `openai==1.95.1` — OpenAI API client
- `google-genai==1.56.0` — Google Gemini API
- `fastembed==0.7.1` — Local embedding (available but not primary)
- `numpy==2.2.6`, `pandas==2.3.3` — Numerical/data
- `beautifulsoup4==4.12.3` — HTML/XML parsing
- `python-dotenv==1.1.1` — Environment config
- `prometheus-client==0.21.1` — Metrics
- `loguru==0.7.3` — Structured logging

---

## 2. Deployment & Infrastructure

### Server Setup

- **Hosting**: IBM Cloud server (IP: `52.117.200.185`)
- **OS**: Linux (Ubuntu)
- **No Dockerfile found** in the repo — services appear to run directly on the server (not containerized in production)
- A `docker-compose.yml` was referenced in README but not present; `docker-compose.observability.yml` exists for the monitoring stack

### Nginx Routing (Port Map)

| Port | Destination | Auth | Purpose |
|------|-------------|------|---------|
| 80 | → HTTPS redirect | — | Force HTTPS |
| 443 | Next.js `:3000` + FastAPI `:5000` | Basic auth | Main app + API |
| 7633 | Qdrant `:6333` (SSL) | Basic auth | Vector database admin |

### Nginx Configuration Details

- **Frontend**: `/` → `localhost:3000` (Next.js), WebSocket upgrade supported, 120s timeout, buffering OFF
- **Backend API**: `/api/*` → `localhost:5000`, 300s timeout (RAG calls are slow), 25MB upload limit, buffering OFF (for SSE streaming)
- **Qdrant**: Port 7633 with SSL + basic auth (`/etc/nginx/.htpasswd`)
- **SSL**: Self-signed certificates at `/etc/nginx/ssl/selfsigned.crt` + `.key`, TLS 1.2 & 1.3

### Running Locally (Dev)

```bash
# Backend
pip install -r app_backend/requirements.txt
uvicorn app_backend.qa_api:app --reload

# Frontend
cd rag-frontend && npm i && NEXT_PUBLIC_API_BASE_URL=http://localhost:5000 npm run dev
```

### Observability Stack (Docker Compose)

- **Prometheus** (`:9090`) — metrics collection, 30-day retention
- **Loki** (`:3100`) — log aggregation
- **Promtail** — log shipper (reads from `/app/logs`, `/var/log`, Docker containers)
- **Grafana** (`:3000`) — dashboards, admin/admin123

---

## 3. API Structure & Endpoints

### Main Application (`qa_api.py` — the monolith)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/qa` | POST | Standard Q&A — returns complete structured answer with citations |
| `/qa_stream` | POST | Streaming Q&A — Server-Sent Events, token-by-token delivery |
| `/chat` | POST | Conversational mode with history (last 3 messages prepended) |
| `/literature_review` | POST | Full literature review generation (7-step pipeline) |
| `/literature_review_stream` | POST | Streaming lit review with progress updates |
| `/doc_summary_stream/{source}` | GET | Streaming document summary generation |
| `/doc_summary_chat/{source}` | GET/POST | Chat with a specific document (Q&A on single paper) |
| `/docs/{source}` | GET | Full document viewer — returns all paragraphs with metadata |
| `/citation/{pdf_id}` | GET | Citation metadata lookup by Mandumah PDF ID |
| `/debug/search` | POST | Detailed search scoring debug info |
| `/translate` | POST | Multi-language translation |
| `/history` | POST | Query history |
| `/dashboard` | GET | Admin dashboard data |
| `/health` | GET | Health check |
| `/auth/check` | GET | Auth validation |
| `/auth/logout` | GET | Logout |
| `/metrics` | GET | Prometheus metrics export |

### Modular Routers

| Router | Prefix | Endpoints |
|--------|--------|-----------|
| Health | `/` | `/health`, `/auth/check`, `/auth/logout` |
| QA | `/` | `/history` |
| Translate | `/` | `/translate` |
| Usage | `/api/usage` | `/log`, `/log-batch`, `/summary` |
| Feedback | `/api/feedback` | Feedback submission and retrieval |
| Literature Review | `/` | `/literature_review` |
| Documents | `/` | `/docs/{source}` |
| Admin v1 | `/admin` | System stats, collections, search, performance, clusters |
| Admin v2 | `/` | `/health`, `/search`, `/browse`, `/inspect/{id}`, `/document/{source}`, `/sources` |

### Admin API v1 Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/admin/system-stats` | Memory, disk, collection stats |
| `/admin/collections` | All Qdrant collection info |
| `/admin/collections/{name}/details` | Specific collection with sample points |
| `/admin/search-documents` | Search across collections with pagination |
| `/admin/performance-metrics` | Response times, req/sec, memory (1h/6h/24h/7d windows) |
| `/admin/embedding-clusters` | Embedding cluster visualization |
| `/admin/similarity-pairs` | High-similarity document pairs |
| `/admin/comprehensive-analysis` | Total points, vectors, unique sources, storage estimate |

### Admin API v2 Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/health` | Qdrant connection status + collection info |
| `/search` | Semantic search with OpenAI embeddings |
| `/browse` | Paginated vector browsing |
| `/inspect/{point_id}` | Deep point inspection with vector statistics |
| `/document/{source}` | All chunks for a document with citation info |
| `/sources` | Unique source list with chunk counts |

---

## 4. Search Pipeline (End-to-End)

```
User Query
    │
    ▼
┌──────────────────────────┐
│ Phase 1: Input & Detection│
│ • Language detection      │
│   (AR/EN/FR/RU/ZH/ES)    │
│ • Query validation        │
│   (Pydantic models)       │
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│ Phase 2: Router Decision  │
│ • If auto_full_docs=True  │
│ • Micro LLM classifier   │
│   (gpt-4o-mini, temp=0)  │
│ • Heuristics: numbers,   │
│   "figure", "table",     │
│   "appendix", long query │
│ • Output: CHUNKS_ONLY    │
│   or NEED_FULL           │
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│ Phase 3: Retrieval                        │
│                                           │
│ Single-Language Path:                     │
│ • Embed query → text-embedding-3-small   │
│ • Search Qdrant (cosine similarity)       │
│ • HNSW_EF=1024, top_k=10                │
│ • Filter out empty chunks                 │
│                                           │
│ Multi-Language Path (مقارنة):              │
│ • Translate query → EN, AR, FR (parallel)│
│ • Embed all queries (parallel)            │
│ • Search Qdrant per language (k*1.5)      │
│ • Merge via Reciprocal Rank Fusion (RRF) │
│   score = Σ 1/(60 + rank)               │
│ • Deduplicate, return top K               │
└──────────┬───────────────────────────────┘
           │
           ▼
┌──────────────────────────┐
│ Phase 4: Context Building │
│ • Get paragraph text      │
│ • Translate chunks if     │
│   multi-language search   │
│ • Build context_blob      │
│   (concatenated text      │
│    with [para_id] tags)   │
│ • Truncate if > 50K chars │
│ • Optionally append full  │
│   document text (≤350K)   │
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│ Phase 5: LLM Generation   │
│ • Select system prompt    │
│   (language × mode ×     │
│    detailed flag)         │
│ • Call gpt-4o-mini        │
│   (temperature=0)        │
│ • Extract citation IDs   │
│   via regex              │
│ • Ensure min citations   │
│   (fallback append)      │
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│ Phase 6: Response         │
│ • answer (markdown)       │
│ • answer_en (translated)  │
│ • citations[] with meta   │
│ • context[] with scores   │
│ • sources[] for display   │
│ • inline_citations[]      │
│ • debug{} with costs,     │
│   timing, token usage     │
└──────────────────────────┘
```

### Response JSON Structure

```json
{
  "answer": "Markdown-formatted answer with [citation_id] references...",
  "answer_en": "Same or translated to English",
  "citations": [
    {
      "id": "1566-000-034-008_chunk67",
      "source": "document.docx",
      "title": "Paper Title",
      "authors": "Author1; Author2",
      "year": "2024",
      "pdf_id": "12345",
      "journal": "Journal Name"
    }
  ],
  "context": [
    {
      "id": "1566-000-034-008_chunk67",
      "text": "Retrieved chunk text...",
      "score": 0.87,
      "source": "document.docx",
      "search_language": "en",
      "citation_meta": { "title": "...", "authors": [...], "year": "2024" }
    }
  ],
  "sources": [
    { "id": "...", "source": "document.docx", "text": "full chunk text" }
  ],
  "inline_citations": [
    {
      "id": "1566-000-034-008_chunk67",
      "display": "2024 — Author Names",
      "url": "/documents/document.docx#1566-000-034-008_chunk67"
    }
  ],
  "debug": {
    "dynamic_full_docs": false,
    "context_char_len": 45230,
    "token_usage": {
      "embedding": { "total_tokens": 15 },
      "router": { "total_tokens": 45 },
      "qa": { "completion_tokens": 156 },
      "costs_usd": { "embedding": 0.0000003, "router": 0.0000072, "qa": 0.0000936, "partial_total": 0.0001011 }
    },
    "timing": { "total_s": 4.231, "embedding_s": 0.234 }
  }
}
```

---

## 5. Document Chunking & Embedding

### Chunking Configuration

| Parameter | Value | Env Variable |
|-----------|-------|-------------|
| Target chunk size | 1000 chars | `DEFAULT_TARGET_CHARS` |
| Minimum chunk size | 350 chars | `DEFAULT_MIN_CHARS` |
| Maximum chunk size | 1600 chars | `DEFAULT_MAX_CHARS` |
| Min paragraph keep | 15 chars | `DEFAULT_MIN_KEEP_PARA` |

### Chunking Strategy (Sentence-Aware)

1. **Parse JSON documents** with structure: `{citation: {...}, paragraphs: [{paragraph: "text"}, ...]}`
2. **Text normalization**: Remove RTL/LTR marks, normalize whitespace
3. **Heading detection**: Identify section titles (مقدمة، الخاتمة / introduction, conclusion)
4. **Boilerplate filtering**: Remove short labels, page numbers, decorative content
5. **Reference section skipping**: Detect المراجع/references → skip indexing that section
6. **Sentence-aware splitting**:
   - Split paragraphs into sentences using `[.!?؟۔]+` boundaries
   - Build chunks sentence-by-sentence until reaching `target_chars` (1000)
   - Find best break point without exceeding `max_chars` (1600)
   - Merge small chunks (<350 chars) with previous chunk
   - Preserve section headers as metadata
7. **Chunk ID format**: `{source_stem}_chunk{N}` (e.g., `1566-000-034-008_chunk67`)

### Embedding Pipeline

| Parameter | Value |
|-----------|-------|
| Model | `text-embedding-3-small` (OpenAI) |
| Dimensions | 1536 |
| Distance metric | Cosine |
| Batch size | 100 texts per API call |
| Concurrency | 10 concurrent requests |
| Rate limit | 2,950 RPM |
| Retry logic | Up to 5 retries with exponential backoff |
| Point ID | Deterministic 64-bit mmh3 hash: `hash("abstract::{record_id}")` |
| Upsert batch | 200 points per Qdrant call |
| Normalization | L2 normalization for cosine distance |

### Embedding Process

Two embedding scripts exist:
- `async_embed_all_qdrant.py` — Concurrent async embedding with deduplication and checkpointing
- `sync_embed_all_qdrant.py` — Sequential sync variant

Both support:
- Checkpoint tracking (processed record IDs saved to text file)
- Processing stats JSON
- Resume from interruption
- Memory monitoring (31GB limit for embedding scripts)

### MARC21 XML Pipeline (for abstracts)

- Stream-parses XML without loading into memory
- Extracts: title, authors, abstract (AR + EN), keywords, journal, pdf_id
- Composes embed text: `title + abstract_ar + abstract_en + keywords + journal`
- Memory efficient: deletes parsed elements immediately
- Target collection: `abstracts_metadata`

---

## 6. Vector Database (Qdrant)

### Connection Details

| Parameter | Value |
|-----------|-------|
| Host | `52.117.200.185` |
| Port | 6333 |
| Timeout | 120 seconds |
| Protocol | gRPC (preferred for performance) |
| Protected by | Nginx reverse proxy on port 7633 with SSL + basic auth |

### Collections

#### `documents_async_01_10_2025` (Primary)

The main search collection containing chunked document paragraphs.

| Setting | Value |
|---------|-------|
| Vector dimensions | 1536 |
| Distance metric | Cosine |
| Vectors storage | On disk (memory efficient) |
| HNSW index | On disk |
| HNSW m | 16 |
| HNSW ef_construct | 100 |
| HNSW ef (search) | 1024 (configurable, adjusted per query) |
| Exact search | false (uses HNSW approximate) |
| Total vectors | **~10.5 million** |

#### `abstracts_metadata` (Secondary)

Contains embedded abstracts with rich metadata for the literature review pipeline.

### Metadata Stored Per Point (Payload)

```json
{
  "paragraph_id": "1566-000-034-008_chunk67",
  "source": "1566-000-034-008.docx",
  "text": "The full chunk text content...",
  "title": "Research Paper Title",
  "authors": "Author1; Author2",
  "date": "2024",
  "url": "",
  "citation_id": "citation_001",
  "section": "Introduction",
  "char_len": 1024,
  "span": { "from": 0, "to": 15 },
  "doc_index": 5
}
```

### Search Configuration

- Dynamic HNSW EF adjustment per query: `min(HNSW_EF, max(k*4, 256))`
- Default top_k: 10
- Multi-language retrieval uses `k*1.5` buffer for merging

---

## 7. Hybrid Search & Reranking

### Current State: Pure Semantic Search

**There is NO hybrid search (keyword + semantic).** The system uses **pure vector similarity search** via Qdrant.

- No BM25/keyword search
- No Elasticsearch integration
- No TF-IDF scoring

### Reranking

**No cross-encoder or learning-to-rank reranking exists.** The only ranking mechanism is:

#### Reciprocal Rank Fusion (RRF) — Multi-Language Only

When `multi_language_search=True`, results from multiple languages are merged using RRF:

$$\text{RRF\_score}(d) = \sum_{src \in \text{languages}} \frac{1}{60 + \text{rank}_{src}(d)}$$

- RRF constant k = 60 (standard)
- Each language's results sorted by Qdrant cosine score
- Contribution calculated per language per document
- Summed across all languages
- Final ranking by RRF score, top K returned
- Deduplication by `paragraph_id`

#### Full Document Router (Not True Reranking)

A micro LLM classifier (`gpt-4o-mini`, temperature=0) decides whether full documents are needed:
- Analyzes query heuristics (numbers, specific cue words like "figure", "table", "appendix")
- Previews first 3 retrieved chunks
- Outputs: `"CHUNKS_ONLY"` or `"NEED_FULL"`
- This is a routing decision, not a reranking step

### What's Missing

- Cross-encoder reranking (e.g., MS-MARCO MiniLM)
- BM25 hybrid search
- LLM-based reranking
- Learning-to-Rank models
- Metadata-based boosting (e.g., recency, citation count)

---

## 8. The 4 Search Modes

### Mode 1: ملخص فوري (Instant Summary)

- **Code**: `mode="search"`, `detailed=False`
- **Retrieval**: Standard single-language semantic search, top_k=10
- **LLM Prompt**: Brief response instruction — "2-3 paragraphs max, essential points only"
- **Output**: Concise, direct answer with minimal citations
- **Use case**: Quick answers when user wants fast results

### Mode 2: مراجعة الاستشهادات المتقدمة (Advanced Citation Review)

- **Code**: `mode="search"`, `detailed=True`
- **Retrieval**: Same as Mode 1 (standard semantic search, top_k=10)
- **LLM Prompt**: Comprehensive structured research format:
  - مقدمة (Introduction)
  - عناصر رئيسية (Main Elements) with subheadings
  - نقاط تفصيلية (Detailed Points) with bullet points
  - خلاصة (Conclusion)
- **Citation rules**: Must cite from 5-6 different sources, strict `[paragraph_id]` format, no author names/dates in citations
- **Output**: Long, structured academic answer with heavy citations
- **Use case**: In-depth research with comprehensive source integration

### Mode 3: بحث اعتيادي (Regular Search)

- **Code**: default / standard search flow
- **Retrieval**: Single-language semantic search, auto-detected language
- **LLM Prompt**: Standard balanced prompt
- **Output**: Moderate-length answer with relevant citations
- **Use case**: Default search experience

### Mode 4: مقارنة (Comparison / Multi-Language Search)

- **Code**: `multi_language_search=True`, `target_languages=["en", "ar", "fr"]`
- **Retrieval**: Fundamentally different pipeline:
  1. **Translation Phase**: Query translated to all target languages in parallel (async OpenAI)
  2. **Embedding Phase**: All queries (original + translated) embedded in parallel
  3. **Search Phase**: Separate Qdrant searches per language (with `k*1.5` buffer)
  4. **Merge Phase**: Reciprocal Rank Fusion across all language results
  5. **Deduplication**: By paragraph_id, sorted by RRF score
  6. **Chunk Translation**: Retrieved chunks translated back to the user's detected language
- **LLM Prompt**: Same as Mode 2 (detailed) but with multi-language context
- **Output**: Answer synthesizing sources across Arabic, English, and French literature
- **Use case**: Cross-language comparative research

### Key Differences Summary

| Aspect | ملخص فوري | مراجعة متقدمة | بحث اعتيادي | مقارنة |
|--------|----------|--------------|-------------|--------|
| Retrieval | Standard | Standard | Standard | Multi-language RRF |
| Languages searched | 1 | 1 | 1 | 3 (AR/EN/FR) |
| Answer length | Short (2-3 para) | Long (structured) | Medium | Long (structured) |
| Citations required | Minimal | 5-6 sources | Moderate | 5-6 cross-language |
| Translation | No | No | No | Yes (query + chunks) |
| LLM calls | 1 | 1 | 1 | 1 (but translation adds more) |

---

## 9. Document Ingestion Pipeline

```
Raw Document (PDF/DOCX)
    │
    ▼
┌─────────────────────────┐
│ EXTRACT.py               │
│ • Convert DOCX → JSON   │
│ • Extract paragraphs    │
│ • Extract citation meta  │
│   (title, authors, year, │
│    journal, pdf_id)      │
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│ chunk_documents.py       │
│ • Sentence-aware split   │
│ • Target: 1000 chars     │
│ • Min: 350, Max: 1600    │
│ • Boilerplate removal    │
│ • Reference skip         │
│ • Section tagging        │
│ • Output: chunked JSON   │
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│ Output JSON files        │
│ • Stored in              │
│   data/chunked_json/ or  │
│   data/prod_server_data/ │
│     chunked_json_prod/   │
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────────────┐
│ async_embed_all_qdrant.py        │
│ • Read chunked JSONs             │
│ • Embed via text-embedding-3-small│
│ • Batch: 100 texts/call          │
│ • Concurrency: 10 requests       │
│ • Upsert to Qdrant (batch: 200) │
│ • Checkpoint tracking            │
│ • Idempotent (mmh3 hash IDs)    │
└──────────┬──────────────────────┘
           │
           ▼
┌─────────────────────────┐
│ Qdrant Collection        │
│ documents_async_01_10_2025│
│ ~10.5M vectors           │
└─────────────────────────┘
```

### Alternative Pipeline: MARC21 XML (Abstracts)

```
MARC21 XML file
    │
    ▼
┌─────────────────────────┐
│ embed_abstracts_qdrant.py│
│ • Stream-parse XML       │
│ • Extract metadata       │
│ • Compose embed text:    │
│   title + abstract_ar +  │
│   abstract_en + keywords │
│   + journal              │
│ • Embed + upsert         │
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│ Qdrant Collection        │
│ abstracts_metadata       │
└─────────────────────────┘
```

### Data Storage Layout

```
/home/appuser/AI-Search/data/
├── chunked_json/                          # Chunked paragraphs (dev/legacy)
├── jsons/                                 # Full documents (dev/legacy)
├── index/
│   ├── paragraphs.index                   # Legacy FAISS index
│   └── paragraphs_meta.pkl               # Legacy FAISS metadata
├── prod_server_data/
│   ├── chunked_json_prod/chunked_json/    # Production chunked JSONs
│   └── vdb_prod/vdb/                      # Production vector DB files
├── All-our-peer-reviewed-journals-csv.csv # Peer-reviewed journal list
└── journals-with-no-rights-csv.csv        # Restricted document IDs
```

Also backed up to S3: bucket `cubez-ai-rag-data`, prefix `v2/jsons/` and `v2/index/`.

---

## 10. Metadata Per Document/Chunk

### Per Document (Citation Object)

```json
{
  "id": "citation_001",
  "title": "عنوان البحث",
  "title_en": "Research Paper Title",
  "authors": ["Author 1", "Author 2"],
  "authors_str": "Author1; Author2",
  "year": 2023,
  "year_int": 2023,
  "pdf_id": "12345",
  "journal": "مجلة البحوث",
  "doi": "10.xxxx/xxxxx"
}
```

### Per Chunk

```json
{
  "id": "1566-000-034-008_chunk67",
  "paragraph": "The actual chunk text content...",
  "source": "1566-000-034-008.docx",
  "citation_id": "citation_001",
  "section": "Introduction",
  "char_len": 1024,
  "span": { "from": 0, "to": 15 },
  "paragraph_index": 5,
  "sentence_count": 8
}
```

### Per Qdrant Vector Point

```json
{
  "id": 8234567890123456,
  "vector": [0.023, -0.041, ...],
  "payload": {
    "paragraph_id": "1566-000-034-008_chunk67",
    "source": "1566-000-034-008.docx",
    "text": "The actual chunk text...",
    "title": "Research Paper Title",
    "authors": "Author1; Author2",
    "date": "2024",
    "url": "",
    "citation_id": "citation_001",
    "section": "Introduction",
    "char_len": 1024,
    "span": { "from": 0, "to": 15 },
    "doc_index": 5
  }
}
```

### Chunking Statistics (per document)

```json
{
  "original_paragraphs": 125,
  "chunks_created": 34,
  "total_chars": 34560,
  "avg_chars_per_chunk": 1016,
  "sentence_aware": true,
  "target_chars": 1000,
  "min_chars": 350,
  "max_chars": 1600
}
```

---

## 11. Document Viewer & Passage Highlighting

### Document Modal (`DocModal.tsx`)

- **Full-screen modal** showing complete document text
- **All paragraphs rendered** with unique DOM IDs: `<div id="docpara-{para.id}">`
- **Mandumah PDF link**: If document has `pdf_id`, shows "Download PDF" → `https://search.mandumah.com/Record/{pdf_id}`
- **Per-paragraph translation**: Each paragraph can be individually translated
- **Citation metadata header**: Shows title, authors, year, journal

### Passage Highlighting Flow

1. User clicks a citation in `CitationsList`
2. Calls `handleViewFullDocument(source, paraId)`
3. `DocModal` opens with `highlightedPara = paraId`
4. On mount: Finds DOM element with `id="docpara-{paraId}"`
5. `scrollIntoView()` with smooth animation
6. Retries up to **20 times** (over 2 seconds) if element not yet rendered
7. CSS styling applied: border/background color highlight on the target paragraph

### Side Document Modal (`SideDocModal.tsx`)

Tabbed interface alongside the main document:

- **Summary Tab**:
  - Two levels: "Detailed" vs "Comprehensive"
  - Streaming generation displayed in real-time
  - Cached summaries in MySQL to avoid re-generation
- **Chat Tab**:
  - Ask questions about the specific document
  - Arabic keyboard support
  - Chat history displayed
  - Endpoint: `POST /doc_summary_chat/{source}`

### Access Restrictions

- Loaded from `journals-with-no-rights-csv.csv` → `RESTRICTED_DOCUMENTS` set
- 3-level matching: exact → partial prefix → journal number
- **Restricted documents**: API returns `"access_restricted": true` with empty paragraphs
- **But**: LLM can still use restricted documents for answering (only user viewing is blocked)

---

## 12. Citation & Reference System

### How Citations Are Generated

1. **In the LLM Prompt**: System prompt explicitly instructs the model to cite using `[paragraph_id]` format
   - Example IDs are embedded in the prompt (e.g., `[1566-000-034-008_chunk67]`)
   - Rules: No author names, no dates, no generic IDs, each citation in separate brackets
2. **Post-Processing**: Regex extracts citations: `\[([\w\-\.,]+_(?:para|chunk)\d+)\]`
3. **Minimum Citations**: If fewer than `CITATIONS_MIN_COUNT` (default 1), fallback references are appended
4. **Citation Metadata**: Each extracted ID is enriched with metadata from the original document JSON

### Display in Frontend

#### Inline Citations (`MarkdownWithCitations.tsx`)

- Citation pattern `[para_id_chunk#]` detected in answer markdown
- **On hover**: Tooltip shows citation metadata (title, authors, year)
- **On click**: Opens `DocModal` with passage highlighting
- Regex: `[[\w\-\.,]+_(?:para|chunk)\d+]`

#### Citations List (`CitationsList.tsx`)

Display priority:
1. `(Author(s) et al., Year)` — preferred
2. `(Title, Year)` — if no authors
3. `(Authors)` — if no year
4. `[ID]` — fallback

Interactive elements:
- Click citation → Opens `DocModal` with highlighted passage
- "Chat with Document" button → Opens `SideDocModal`
- Styled with gradient backgrounds, hover effects, red/brown theme

#### References List (`ReferencesList.tsx`)

- Shows context paragraphs that were retrieved but **not cited** in the answer
- Each item: source name, text preview, "View full text" link → `DocModal`

### APA Citation Generation

Citations are formatted in the frontend using metadata:
- **Format**: `Author(s). (Year). Title. Journal.`
- Generated from: `citation_meta.authors`, `citation_meta.year`, `citation_meta.title`, `citation_meta.journal`
- No dedicated APA formatter library — hand-coded formatting logic

---

## 13. Document Analysis Panel

### Summary Generation

- **Endpoint**: `GET /doc_summary_stream/{source}`
- **Process**: Loads full document text → sends to LLM with summary prompt
- **Two levels**:
  - **Detailed**: Standard summary
  - **Comprehensive**: Extended analysis
- **Streaming**: Server-Sent Events for real-time display
- **Caching**: Summaries cached in MySQL `paper_abstracts` table with key `(source, level, language)`
- **Cache tracking**: `access_count` and `last_accessed` updated on hits

### Document Chat

- **Endpoint**: `POST /doc_summary_chat/{source}`
- **Process**: Load document → cached summary as context → Q&A on that specific paper
- **Features**: Chat history, Arabic keyboard support

### Literature Review Panel (`LiteratureReviewPanel.tsx`)

7-step pipeline producing a full academic literature review:

1. **Retrieval**: Query → embed → search Qdrant (k = num_papers × 6 for diversity)
2. **Aggregation**: Group chunks by source document
3. **Relevance Filtering**: LLM scores each paper 0-10, filter below 4 (configurable `min_relevance_score=7`)
4. **Selection**: Top papers by relevance (default 5, max 20)
5. **Summarization**: Per-paper structured summary (methodology, results, limitations) — parallel via asyncio
6. **Narrative Generation**: Introduction (4-5 para) → Synthesis (5-7 para) → Conclusion (4-5 para)
7. **Metrics**: Year range, top authors, common themes, methodology distribution (Quantitative/Qualitative/Mixed)

**LLM Used**: Gemini 2.5 Flash (1M token context) for lit reviews; OpenAI GPT-4o as fallback.

**Per-Paper Summary Fields**:
- `research_problem` (3-5 sentences, CRITICAL)
- `methodology` (3-5 sentences with explicit type classification)
- `key_results` (4-7 sentences with specific figures/stats)
- `limitations` (only if explicitly mentioned)
- `research_recommendations` (future directions or "not mentioned")

---

## 14. Filters

### Current State: Very Limited Filtering

#### What Exists

| Filter | Where Applied | How |
|--------|--------------|-----|
| Peer-reviewed journal filter | Literature Review ONLY | Loaded from `All-our-peer-reviewed-journals-csv.csv` at startup; only peer-reviewed journal papers included in lit reviews |
| Document access restriction | Document viewer | Loaded from `journals-with-no-rights-csv.csv`; 3-level prefix matching; blocks viewing but not LLM usage |
| Multi-language search toggle | Search UI | Checkbox enables EN/AR/FR parallel search |

#### What Does NOT Exist

- **No journal filter** in regular search
- **No author filter**
- **No date range filter**
- **No topic/category filter**
- **No keyword/full-text search** (only vector similarity)
- **No metadata-based filtering** in Qdrant queries (no Qdrant filter conditions used)

This is a significant gap — all retrieval is pure semantic similarity with no structured filtering.

---

## 15. Authentication Model

### Two-Tier Session Architecture

```
User Request
    │
    ├─→ Check AI_SESSION cookie (Redis)
    │   └─→ Valid? → Use cached session data → Done
    │
    └─→ Invalid/Expired
        │
        ├─→ Check auth_mem_key cookie (Memcache)
        │   └─→ Valid? → Create new AI_SESSION in Redis → Set cookie → Done
        │
        └─→ Both invalid → Return 401
```

#### Layer 1: Memcache (Initial Validation) — `session_auth.py`

| Setting | Value |
|---------|-------|
| Cookie name | `auth_mem_key` |
| Memcache server | `10.220.8.189:11213` |
| Key format | `mandumah_login:patron_login_{session_hash}` |
| Data format | PHP-serialized session objects |
| Timeout | 5 minutes |

**Extracted Data**:
- `user_id`, `username` (from `cat_username`)
- `client_name_en`, `client_name_ar` (organization names)
- `subscribed_databases` (list of accessible databases)
- `firstname`, `lastname` (combined for display)

#### Layer 2: Redis (AI Sessions) — `ai_session.py`

| Setting | Value |
|---------|-------|
| Cookie name | `AI_SESSION` |
| Session ID | Cryptographic `token_urlsafe(32)` |
| Expiry | 15 minutes (sliding window, auto-refresh) |
| Storage | JSON in Redis |
| Max history | 20 items per session |

#### Dev Mode

- Set `DEV_MODE=true` in `.env` to bypass all authentication
- Returns mock user: `{user_id: 'dev_user', username: 'developer'}`
- **Currently enabled** in the `.env` file

#### UserSession Data Class

```python
@dataclass
class UserSession:
    user_id: str
    username: str
    client_name_en: str
    client_name_ar: str
    subscribed_databases: list
    raw_data: Dict[str, Any]
```

---

## 16. User Roles & Permissions

### Current State: No RBAC

There is **no role-based access control**. The system has two effective levels:

| Level | Access |
|-------|--------|
| **Authenticated user** | Full access to search, chat, literature review, document viewing (except restricted docs) |
| **Admin** | Nginx basic auth (`/etc/nginx/.htpasswd`) for admin dashboard and Qdrant |

- No user roles stored in session data
- No permission checks per endpoint (except admin)
- No subscription-tier differentiation
- The `subscribed_databases` field exists in session data but is **not used** for authorization

---

## 17. Admin Dashboard

### Admin Dashboard UI (`admin-dashboard/`)

Next.js app with:
- `CollectionStats.tsx` — Qdrant collection statistics
- `DataInspectorTab.tsx` — Raw data inspection
- `DocumentBrowser.tsx` — Browse documents
- `DocumentViewerTab.tsx` — View specific documents
- `EmbeddingVisualization.tsx` — Visualize embedding clusters
- `PerformanceDashboard.tsx` — Performance metrics
- `SearchTestTab.tsx` — Test search queries

### Admin API Capabilities

| Capability | Endpoints |
|-----------|-----------|
| System monitoring | Memory, disk, CPU usage |
| Collection management | List collections, view details, sample points |
| Document search | Semantic search across collections with pagination |
| Performance metrics | Response times, requests/sec, memory (1h/6h/24h/7d) |
| Embedding visualization | Cluster analysis (mock data) |
| Similarity analysis | High-similarity document pair detection |
| Point inspection | Deep inspection with vector statistics |
| Document browsing | Paginated browsing of vectors |
| Source management | List unique sources with chunk counts |

### Access Control

- Protected by Nginx basic auth only
- No session-based admin authentication
- No audit logging for admin actions

---

## 18. Data Scale

| Metric | Value |
|--------|-------|
| **Total vectors** | ~10.5 million |
| **Primary collection** | `documents_async_01_10_2025` |
| **Secondary collection** | `abstracts_metadata` |
| **Vector dimensions** | 1536 |
| **Estimated storage** | Multi-GB on disk (vectors stored on disk, not in RAM) |
| **Document format** | Chunked JSON files |
| **Chunk size** | ~1000 chars average |
| **Data location** | `/home/appuser/AI-Search/data/prod_server_data/` |
| **S3 backup** | `s3://cubez-ai-rag-data/v2/` |

### Qdrant Performance Characteristics (at 10.5M vectors)

- HNSW approximate search: fast but not exact
- Vectors on disk: lower memory but higher latency
- HNSW EF=1024: high accuracy setting (slower than default)
- Network latency is a significant factor (remote Qdrant server)

---

## 19. Relationship with Mandumah

### What is Mandumah?

**Mandumah** (دار المنظومة, `search.mandumah.com`) is an **Arabic academic research database** — a major publisher/aggregator of Arabic-language scholarly journals and theses.

### Relationship

This system is **built on top of Mandumah's data**. Specifically:

1. **Data Source**: The documents indexed are sourced from Mandumah's academic database
2. **Authentication**: The auth system reads Mandumah's Memcache session cookies (`mandumah_login:patron_login_{hash}`) — users log in through Mandumah's platform
3. **PDF Downloads**: Documents link back to Mandumah for full PDF access: `https://search.mandumah.com/Record/{pdf_id}`
4. **Access Control**: Restricted journal lists (`journals-with-no-rights-csv.csv`) control which documents can be viewed, likely based on Mandumah's licensing
5. **Journal Metadata**: Peer-reviewed journal lists used for literature review filtering come from Mandumah's catalog
6. **Session Integration**: User sessions carry `client_name_en/ar` and `subscribed_databases` from Mandumah's institutional subscription model

### Not a Replacement

The AI Search system is **not replacing** Mandumah's search — it's an AI-powered layer that:
- Takes Mandumah's document corpus
- Chunks and embeds it into a vector database
- Provides semantic search, Q&A, literature review, and document chat capabilities
- Links back to Mandumah for original PDF access

---

## 20. Pain Points & Technical Debt

### Critical Issues

#### 1. God Object: `qa_api.py` (7,600+ lines)

The main backend file is a massive monolith containing:
- ~300 lines of global configuration
- 15+ endpoint definitions
- 10+ global state variables
- Embedding, translation, answer generation, caching logic
- Literature review pipeline (~1,000+ lines)
- All interleaved with no clear separation of concerns

**Impact**: Extremely difficult to test, debug, modify, or onboard new developers.

#### 2. Hardcoded Credentials in Source Code

```
# Found in .env (committed to git):
OPENAI_API_KEY=sk-proj-XaUXm...
GOOGLE_API_KEY=AIzaSyAUc...
AWS_ACCESS_KEY_ID=AKIAXD...
AWS_SECRET_ACCESS_KEY=mjU4HX...

# Found in summary_cache.py:
'password': 'Quantum1~~2004'
```

**Impact**: Major security vulnerability. All API keys and database passwords are exposed in the repository.

#### 3. No Hybrid Search

Pure semantic search with no keyword/BM25 component means:
- Exact term searches may miss results
- No way to search by author name, journal, date, or specific terms
- No metadata filtering in Qdrant queries
- Users can't narrow results by any structured field

**Impact**: Significantly limits search precision and user control.

#### 4. No Cross-Encoder Reranking

Retrieved results are ranked only by cosine similarity. No second-stage reranking means:
- Lower relevance precision
- No learned relevance signals
- Multi-language results quality depends entirely on translation + embedding quality

#### 5. Global State & Race Conditions

```python
_qdrant_client = None          # Singleton, no factory
_paragraphs_by_id = None       # Lazy loaded, potential race condition
_full_docs_by_source = None    # Hard to test
PEER_REVIEWED_JOURNALS = set() # Loaded at startup, never refreshed
_json_file_cache = {}          # Manual cache without eviction policy
```

**Impact**: Concurrent requests may hit uninitialized state; testing requires mocking globals.

#### 6. Dual Implementation Problem

The codebase has **both** inline functions in `qa_api.py` AND refactored service classes:
- `services/answer.py` exists but `qa_api.py` still has inline answer generation
- `services/retrieval.py` exists but `qa_api.py` still directly calls Qdrant
- Import fallbacks silently swallow errors: `try: from services.answer import ...; except: <inline>`

**Impact**: Unclear which code path runs in production; bugs may be fixed in one place but not the other.

#### 7. Translation Duplication

Six nearly identical translation functions exist:
- `translate_to_english()`
- `translate_to_arabic()`
- `translate_to_russian()`
- `translate_to_chinese()`
- `translate_to_french()`
- `translate_to_spanish()`

**Impact**: Code duplication, inconsistent behavior, maintenance burden.

#### 8. Frontend Monolith

`index.tsx` (main search page) is **5,779 lines** — another god file containing:
- Search logic
- Results display
- Document viewer
- Literature review panel
- Translation UI
- Voice input
- Mobile layout

#### 9. No Query Result Caching

Every query, even identical ones, triggers:
- A new embedding API call
- A new Qdrant search
- A new LLM generation call

**Impact**: Wasted API costs and unnecessarily slow repeated queries.

#### 10. DEV_MODE Enabled in Production Config

`DEV_MODE=true` in the `.env` file bypasses all authentication. If this reaches production, any user can access the system without logging in.

#### 11. Missing Metadata Timestamps

The 10.5M existing vectors have **no timestamps** in their payloads. This means:
- Cannot track when documents were indexed
- Cannot do recency-based ranking
- Cannot implement "new documents" features
- Cannot efficiently do incremental updates

#### 12. Inconsistent Memory Limits

- Main app: `MEMORY_LIMIT_MB=1000` (1GB)
- Embedding scripts: `MEMORY_LIMIT_MB=31000` (31GB)
- No container-level memory limits (no Docker in production)

#### 13. Error Handling Anti-Patterns

- Silent fallbacks: `try: import X; except: pass` throughout
- Lost stack traces: `except Exception as e: logger.error(str(e))`
- No distinction between "expected fallback" and "real error"
- Error messages exposed to users via API responses

#### 14. No Proper Test Coverage for the Monolith

- 16 test files exist for the service layer
- But `qa_api.py` (the actual running code) has **no direct tests**
- The refactored services are tested but may not be the code path that runs

#### 15. N+1 File Loading Pattern

On-demand document loading opens JSON files individually:
- Each paragraph ID lookup opens its source JSON file
- Cached after first load, but initial cold-start is expensive
- No batch preloading strategy

---

### Recommended Priorities for Rebuild

| Priority | Issue | Effort |
|----------|-------|--------|
| **P0** | Remove hardcoded credentials, use proper secrets management | Low |
| **P0** | Decompose `qa_api.py` into proper modules | High |
| **P1** | Add hybrid search (BM25 + semantic) | Medium |
| **P1** | Add metadata filters (journal, author, date, topic) | Medium |
| **P1** | Add cross-encoder reranking | Medium |
| **P1** | Implement query result caching | Low |
| **P2** | Decompose frontend `index.tsx` | High |
| **P2** | Add proper RBAC and admin authentication | Medium |
| **P2** | Containerize with Docker for production | Medium |
| **P2** | Add timestamps to vector payloads | Medium |
| **P3** | Unify translation functions | Low |
| **P3** | Resolve dual implementation problem | Medium |
| **P3** | Add comprehensive test coverage | High |
