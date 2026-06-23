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

COMPOSE="docker compose --project-directory docker"

# Probe liveness by attempting a no-op exec. This avoids python3/python
# portability differences and project-name mismatches from -f vs --project-directory.
if ! $COMPOSE exec -T auto-tagger true 2>/dev/null; then
    echo "auto-tagger container is not running — start the stack first:" >&2
    echo "  task start   (or: cd docker && docker compose up -d)" >&2
    exit 2
fi

# Run the Python entrypoint inside the auto-tagger container so it
# picks up the live env (PAPERLESS_*, OLLAMA_*, QDRANT_URL). `-T`
# disables TTY so the JSON-line output stays clean for parsing.
# MSYS_NO_PATHCONV=1 + double-slash prefix prevents Git Bash from
# converting the container path to a Windows path.
MSYS_NO_PATHCONV=1 $COMPOSE exec -T auto-tagger //app/.venv/bin/python -m auto_tagger.backfill "$@"
