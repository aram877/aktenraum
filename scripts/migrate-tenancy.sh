#!/usr/bin/env bash
# migrate-tenancy.sh — one-off tenancy migration (ADR-009, OpenSpec
# tenancy-foundation §6). Runs inside the aktenraum-api container so it uses
# the live env (DATABASE_URL, PAPERLESS_*, QDRANT_*) and the backup status
# volume.
#
# Usage:
#   bash scripts/migrate-tenancy.sh --dry-run            # plan only, writes nothing
#   bash scripts/migrate-tenancy.sh                      # real run (needs a backup < 2 h)
#   bash scripts/migrate-tenancy.sh --i-have-a-backup    # skip the backup gate (you made one yourself)
#
# Steps (each idempotent — re-run after a crash): household/member/personal
# space → Paperless users + groups → shared vocabulary (owner = null) → home
# space for every document → Paperless owner + permissions → Qdrant space
# backfill → verification (drift report + a document count through the
# member's own Paperless user).
#
# Output: JSON-line events on stdout (one per step); the human summary on
# stderr. Exit codes: 0 ok (or dry run), 1 verification found drift,
# 2 configuration problem, 3 refused by the backup gate.

set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose --project-directory docker"

if ! $COMPOSE exec -T aktenraum-api true 2>/dev/null; then
    echo "aktenraum-api container is not running — start the stack first:" >&2
    echo "  task start   (or: cd docker && docker compose up -d)" >&2
    exit 2
fi

# MSYS_NO_PATHCONV=1 keeps Git Bash from rewriting the container path.
MSYS_NO_PATHCONV=1 $COMPOSE exec -T aktenraum-api node dist/tenancy/migrate.js "$@"
