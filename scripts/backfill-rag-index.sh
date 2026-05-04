#!/usr/bin/env bash
# backfill-rag-index.sh — populate the RAG vector index from existing
# `ai-propagated` documents. Idempotent and resumable: re-running on a
# fully-indexed corpus is a fast no-op.
#
# Usage:
#   bash scripts/backfill-rag-index.sh           # skip already-indexed
#   bash scripts/backfill-rag-index.sh --force   # re-index everything
#
# Why a shell wrapper at all when the heavy lifting is Python? The
# desktop shell (per ADR-002) shells out for setup tasks rather than
# embedding a Python interpreter. Keeping every long-lived task
# behind a `scripts/*.sh` entrypoint lets the future Tauri app stream
# stdout JSON-line events into a progress UI without caring whether
# the implementation is shell, Python, or something else.
#
# Output: JSON-line events on stdout (parsed by the desktop shell);
# anything on stderr is human prose for the developer.

set -euo pipefail

cd "$(dirname "$0")/.."

if ! docker compose -f docker/docker-compose.yml ps auto-tagger --format json 2>/dev/null | python3 -c "
import json, sys
try:
    state = json.load(sys.stdin)
    sys.exit(0 if state.get('State') == 'running' else 1)
except Exception:
    sys.exit(1)
" 2>/dev/null; then
    echo "auto-tagger container is not running — start the stack first:" >&2
    echo "  cd docker && docker compose -f docker/docker-compose.yml up -d" >&2
    exit 2
fi

# Run the Python entrypoint inside the auto-tagger container so it
# picks up the live env (PAPERLESS_*, OLLAMA_*, QDRANT_URL). `-T`
# disables TTY so the JSON-line output stays clean for parsing.
docker compose -f docker/docker-compose.yml exec -T auto-tagger /app/.venv/bin/python -m auto_tagger.backfill "$@"
