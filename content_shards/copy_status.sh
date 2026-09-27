#!/usr/bin/env bash
# Live status of the mandumah_v1 -> mandumah_v2 copy.
#   ./content_shards/copy_status.sh          # live (Ctrl-C to quit)
#   ./content_shards/copy_status.sh --once   # one snapshot
cd "$(dirname "$0")/.." || exit 1
exec .venv/bin/python content_shards/copy_status.py "$@"
