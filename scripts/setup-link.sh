#!/usr/bin/env bash
# setup-link.sh — print a single-use setup link (30 minutes) for a member
# (auth-passkeys, ADR-010 step 4). Opening it creates a passkey and new
# recovery codes. Use it for the first run (passwordless admin) and as the
# last resort when nobody can sign in any more.
#
# Usage:
#   bash scripts/setup-link.sh <username>      (or: task setup-link USER=<username>)
#
# Runs inside the aktenraum-api container (direct database access, no
# session needed). stdout: the link only; messages go to stderr.
# Exit codes: 0 ok, 2 usage / stack not running, 4 no such member.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
    echo "Usage: bash scripts/setup-link.sh <username>" >&2
    exit 2
fi

COMPOSE="docker compose --project-directory docker"

if ! $COMPOSE exec -T aktenraum-api true 2>/dev/null; then
    echo "aktenraum-api container is not running — start the stack first:" >&2
    echo "  task start   (or: cd docker && docker compose up -d)" >&2
    exit 2
fi

# MSYS_NO_PATHCONV=1 keeps Git Bash from rewriting the container path.
MSYS_NO_PATHCONV=1 $COMPOSE exec -T aktenraum-api node dist/auth/setup-link-cli.js "$1"
