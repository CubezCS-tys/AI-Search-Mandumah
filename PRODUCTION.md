# Production Deployment Plan

---

## What we're deploying

| Component | How it runs |
|---|---|
| FastAPI backend | Systemd service via `.venv/bin/uvicorn` |
| Qdrant vector DB | Systemd service via the `qdrant` binary |
| Next.js frontend | Vercel (recommended) or Node.js on the same server |
| Nginx | Reverse proxy + SSL termination |

**No Docker required.** The stack is simple enough to run as plain systemd services, which is easier to debug and maintain on a single VPS.

---

## Minimum server spec

| Resource | Minimum | Recommended |
|---|---|---|
| RAM | 8 GB | 16 GB |
| CPU | 2 cores | 4 cores |
| Disk | 20 GB SSD | 40 GB SSD |
| OS | Ubuntu 22.04 / 24.04 | same |

**Why 8 GB RAM minimum:** embeddings are now produced via the OpenAI API (no local model held in RAM). Qdrant needs ~0.5–1 GB depending on collection size, and the OS + FastAPI process take ~1 GB. 8 GB gives comfortable headroom; the API itself is lightweight since it only makes network calls to OpenAI.

**Disk:** the `output/` directory is currently 8.2 GB (PDFs + Azure DI JSONs). Budget for it to grow.

---

## Step 1 — Prepare the server

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y python3.12 python3.12-venv python3-pip nginx git rsync
```

Create a dedicated user (never run as root):

```bash
sudo useradd -m -s /bin/bash mandumah
sudo su - mandumah
```

---

## Step 2 — Transfer the codebase

From your local machine:

```bash
# Copy the project (exclude venv, node_modules, and the qdrant binary — we'll get those fresh)
rsync -avz --progress \
  --exclude '.venv' \
  --exclude 'frontend/node_modules' \
  --exclude 'frontend/.next' \
  --exclude 'qdrant' \
  --exclude 'snapshots' \
  /home/yassine/AI-Search-Mandumah/ \
  mandumah@YOUR_SERVER_IP:/home/mandumah/app/
```

---

## Step 3 — Transfer the data

The data is too large for git. Transfer it separately:

```bash
# Transfer the output directory (8.2 GB — PDFs + OCR JSON)
rsync -avz --progress \
  /home/yassine/AI-Search-Mandumah/output/ \
  mandumah@YOUR_SERVER_IP:/home/mandumah/app/output/

# Transfer the Qdrant storage (8.9 MB — the already-indexed vectors)
rsync -avz --progress \
  /home/yassine/AI-Search-Mandumah/storage/ \
  mandumah@YOUR_SERVER_IP:/home/mandumah/app/storage/
```

> If you plan to re-ingest everything from scratch on the server rather than transferring the storage, skip the second command and run `python -m pipeline.ingest` on the server after setup (Step 6).

---

## Step 4 — Python environment

On the server:

```bash
cd /home/mandumah/app
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Embeddings are produced via the OpenAI API, so there is no large model to pre-download. Ensure `OPENAI_API_KEY` is set in `.env` (Step 5) before running ingestion or search.

---

## Step 5 — Qdrant

Download the Qdrant binary for Linux:

```bash
cd /home/mandumah/app
wget https://github.com/qdrant/qdrant/releases/latest/download/qdrant-x86_64-unknown-linux-musl.tar.gz
tar -xzf qdrant-x86_64-unknown-linux-musl.tar.gz
chmod +x qdrant
rm qdrant-x86_64-unknown-linux-musl.tar.gz
```

Create a Qdrant config file:

```bash
cat > /home/mandumah/app/qdrant_config.yaml << 'EOF'
storage:
  storage_path: ./storage

service:
  host: 127.0.0.1   # bind to localhost only — nginx proxies externally
  http_port: 6333
  grpc_port: 6334
EOF
```

Create a systemd service:

```bash
sudo tee /etc/systemd/system/qdrant.service << 'EOF'
[Unit]
Description=Qdrant Vector Database
After=network.target

[Service]
Type=simple
User=mandumah
WorkingDirectory=/home/mandumah/app
ExecStart=/home/mandumah/app/qdrant --config-path qdrant_config.yaml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable qdrant
sudo systemctl start qdrant
sudo systemctl status qdrant
```

Verify it's running and the collection is intact:

```bash
curl http://127.0.0.1:6333/collections/academic_articles
```

---

## Step 6 — Environment variables

```bash
cat > /home/mandumah/app/.env << 'EOF'
OPENAI_API_KEY=sk-...
QDRANT_URL=http://127.0.0.1:6333
COLLECTION_NAME=academic_articles
OUTPUT_DIR=/home/mandumah/app/output

# Protect the API — set a strong random string
API_KEY=your-strong-random-key-here
EOF

chmod 600 /home/mandumah/app/.env
```

---

## Step 7 — FastAPI service

```bash
sudo tee /etc/systemd/system/mandumah-api.service << 'EOF'
[Unit]
Description=Mandumah Search API
After=network.target qdrant.service
Wants=qdrant.service

[Service]
Type=simple
User=mandumah
WorkingDirectory=/home/mandumah/app
EnvironmentFile=/home/mandumah/app/.env
ExecStart=/home/mandumah/app/.venv/bin/uvicorn backend.main:app \
    --host 127.0.0.1 \
    --port 8000 \
    --workers 2 \
    --no-access-log
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable mandumah-api
sudo systemctl start mandumah-api
sudo systemctl status mandumah-api
```

> **Note on `--workers 2`:** each worker process is lightweight since embeddings come from the OpenAI API rather than a local model. Scale workers based on CPU cores and expected concurrency.

---

## Step 8 — Frontend

### Option A: Vercel (recommended)

1. Push the repo to GitHub
2. Import the `frontend/` folder as a Vercel project
3. Set environment variable in Vercel dashboard: `NEXT_PUBLIC_API_URL=https://api.yourdomain.com`
4. Deploy

Done. Vercel handles CDN, SSL, and scaling automatically.

### Option B: Self-hosted on the same server

```bash
cd /home/mandumah/app/frontend
npm install
NEXT_PUBLIC_API_URL=https://api.yourdomain.com npm run build

sudo tee /etc/systemd/system/mandumah-frontend.service << 'EOF'
[Unit]
Description=Mandumah Frontend
After=network.target

[Service]
Type=simple
User=mandumah
WorkingDirectory=/home/mandumah/app/frontend
Environment=PORT=3000
ExecStart=/usr/bin/node node_modules/.bin/next start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable mandumah-frontend
sudo systemctl start mandumah-frontend
```

---

## Step 9 — Nginx + SSL

Install Certbot:

```bash
sudo apt install -y certbot python3-certbot-nginx
```

Create Nginx config (replace `yourdomain.com` with your actual domain):

```bash
sudo tee /etc/nginx/sites-available/mandumah << 'EOF'
# API
server {
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Required for SSE streaming (chat)
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        chunked_transfer_encoding on;
    }
}

# Frontend (only needed for Option B — skip if using Vercel)
server {
    server_name yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/mandumah /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Get SSL certificates:

```bash
sudo certbot --nginx -d api.yourdomain.com -d yourdomain.com
```

Certbot auto-renews. Verify with:

```bash
sudo certbot renew --dry-run
```

---

## Step 10 — Update CORS for production

Edit `backend/main.py` to add your production frontend URL:

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://yourdomain.com",       # add this
        "https://www.yourdomain.com",   # add this
    ],
    ...
)
```

Then restart the service: `sudo systemctl restart mandumah-api`

---

## Step 11 — Running ingestion on the server

To ingest new documents later:

```bash
# Add new Azure DI JSON + PDF files to /home/mandumah/app/output/output_XXXX/...
# Then run (checkpoint resumes from where it left off):
cd /home/mandumah/app
.venv/bin/python -m pipeline.ingest --input-dir output/
```

Ingestion calls the OpenAI embedding API concurrently (rate-limited). It runs in the background while the API stays live. You can also add `--limit 10` to test a small batch first.

---

## Ongoing operations

### Check service health

```bash
sudo systemctl status qdrant mandumah-api mandumah-frontend
```

### View logs

```bash
sudo journalctl -u mandumah-api -f      # live API logs
sudo journalctl -u qdrant -f             # Qdrant logs
```

### Deploy an update

```bash
cd /home/mandumah/app
git pull

# Backend update
sudo systemctl restart mandumah-api

# Frontend update (Option B only)
cd frontend && npm run build
sudo systemctl restart mandumah-frontend
```

### Back up the vector index

```bash
# Take a Qdrant snapshot (safe while running)
curl -X POST http://127.0.0.1:6333/collections/academic_articles/snapshots

# Or just rsync the storage directory
rsync -avz /home/mandumah/app/storage/ backups@backup-server:/backups/qdrant/
```

---

## Summary checklist

- [ ] Provision server (≥8 GB RAM, ≥20 GB SSD)
- [ ] Create `mandumah` user
- [ ] Transfer codebase via rsync
- [ ] Transfer `output/` (8.2 GB) via rsync
- [ ] Transfer `storage/` (8.9 MB) via rsync
- [ ] Set up Python venv and install requirements
- [ ] Install and start Qdrant as systemd service
- [ ] Verify Qdrant collection is intact (407 points)
- [ ] Create `.env` with `OPENAI_API_KEY` and `API_KEY`
- [ ] Start FastAPI as systemd service
- [ ] Deploy frontend to Vercel (or set up Node service)
- [ ] Configure Nginx reverse proxy
- [ ] Get SSL certificate with Certbot
- [ ] Update CORS origins in `backend/main.py`
- [ ] Test all endpoints end-to-end
