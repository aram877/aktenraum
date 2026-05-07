#!/usr/bin/env bash
# run-rag-eval.sh — execute the RAG eval harness against the live stack.
#
# Wraps `python -m aktenraum_api.eval.runner` running inside the
# aktenraum-api container so it picks up the live Qdrant / Ollama /
# reranker config from env without the host needing any of those deps.
#
# Usage:
#   bash scripts/run-rag-eval.sh                # text report on stdout
#   bash scripts/run-rag-eval.sh --json         # machine-parseable
#   bash scripts/run-rag-eval.sh --top-k 10     # widen retrieval window
#
# Requires a populated `evals/golden-questions.yaml`. The committed
# file is keyed to the dev maintainer's corpus; buyers copy it to a
# private path and re-pin against their own ids.

set -euo pipefail

cd "$(dirname "$0")/.."

if ! docker compose -f docker/docker-compose.yml ps aktenraum-api --format json 2>/dev/null | python3 -c "
import json, sys
try:
    state = json.load(sys.stdin)
    sys.exit(0 if state.get('State') == 'running' else 1)
except Exception:
    sys.exit(1)
" 2>/dev/null; then
    echo "aktenraum-api container is not running — start the stack first:" >&2
    echo "  cd docker && docker compose up -d" >&2
    exit 2
fi

# `-T` keeps stdout clean for `--json` consumers.
docker compose -f docker/docker-compose.yml exec -T aktenraum-api \
    /app/.venv/bin/python -m aktenraum_api.eval.runner "$@"
