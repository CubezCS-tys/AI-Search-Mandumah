#!/usr/bin/env bash
# Safe, throttled, watchdog-protected overnight ingest.
# Run INSIDE tmux/screen so it survives SSH disconnect:
#     tmux new -s embed
#     bash content_shards/run_ingest_safe.sh
#     (detach with Ctrl-b then d ; reattach with: tmux attach -t embed)
set -u
cd /home/appuser/AI-Search-Mandumah
# load the OpenAI key the embedder needs (ingest does not auto-load .env)
export OPENAI_API_KEY=$(grep -E '^OPENAI_API_KEY=' .env | head -1 | cut -d= -f2- | tr -d "\"' ")
TS=$(date +%Y%m%d_%H%M)
INGEST_LOG="ingest_${TS}.log"
WD_LOG="content_shards/watchdog_${TS}.log"

echo "=== safe ingest run $TS ==="
echo "v2 config (memmap_threshold=20000, binary quant expected):"
curl -s http://localhost:6333/collections/mandumah_v2 \
  | python3 -c "import sys,json;o=json.load(sys.stdin)['result']['config'];print('  memmap_threshold =',o['optimizer_config'].get('memmap_threshold'),'| quant =',o.get('quantization_config'))" 2>/dev/null

# 1) start the memory watchdog (waits for the ingest to appear, then guards it)
.venv/bin/python content_shards/watchdog_ingest.py > "$WD_LOG" 2>&1 &
WD=$!
echo "watchdog pid $WD  (log: $WD_LOG)"

# 2) throttled ingest: low concurrency + small batch so writes don't outrun
#    Qdrant's optimizer; bounded --limit for one overnight run.
.venv/bin/python -m backend.pipeline.ingest \
  --input-jsonl content_shards/ \
  --marc-db "$HOME/marc_metadata.db" \
  --collection mandumah_v2 \
  --limit "${LIMIT:-50000}" \
  --max-concurrent 3 \
  --batch-size 50 \
  2>&1 | tee "$INGEST_LOG"

# 3) stop the watchdog when the ingest finishes
kill "$WD" 2>/dev/null
echo "=== ingest finished. log: $INGEST_LOG ==="
