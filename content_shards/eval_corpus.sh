#!/usr/bin/env bash
# Corpus-wide retrieval + PDF-correspondence eval across all 3 federated collections.
#   ./content_shards/eval_corpus.sh --sample 300
cd "$(dirname "$0")/.." || exit 1
exec .venv/bin/python content_shards/eval_corpus.py "$@"
