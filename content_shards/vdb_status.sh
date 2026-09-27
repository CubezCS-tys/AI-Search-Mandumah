#!/usr/bin/env bash
# Full vector-DB pipeline status: collections, ingest progress, live runs, memory, scheduled stop.
#   ./content_shards/vdb_status.sh          # one snapshot
#   ./content_shards/vdb_status.sh --watch  # live refresh every 5s (Ctrl-C to quit)
cd "$(dirname "$0")/.." || exit 1
exec .venv/bin/python content_shards/vdb_status.py "$@"
