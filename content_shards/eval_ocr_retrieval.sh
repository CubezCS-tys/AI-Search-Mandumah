#!/usr/bin/env bash
# Retrieval-quality evaluation over the whole mandumah_ocr_v1 corpus.
#   ./content_shards/eval_ocr_retrieval.sh --sample 200
cd "$(dirname "$0")/.." || exit 1
exec .venv/bin/python content_shards/eval_ocr_retrieval.py "$@"
