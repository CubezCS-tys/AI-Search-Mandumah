#!/usr/bin/env bash
# Live dashboard for the OCR corpus embedding run (mandumah_ocr_v1).
#   ./content_shards/ocr_dashboard.sh          # live (Ctrl-C to quit)
#   ./content_shards/ocr_dashboard.sh --once    # one snapshot
cd "$(dirname "$0")/.." || exit 1
exec .venv/bin/python content_shards/ocr_dashboard.py "$@"
