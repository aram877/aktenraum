#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# aktenraum backup script
#
# Required env vars:
#   RESTIC_PASSWORD       — passphrase for the local restic repository
#   PAPERLESS_DBUSER      — postgres username (default: paperless)
#   PAPERLESS_DBPASS      — postgres password
#
# Optional env vars (for B2 remote):
#   BACKUP_B2_BUCKET      — if set, also push snapshot to B2
#   RESTIC_REPOSITORY_2   — full restic repository URL for B2
#   B2_ACCOUNT_ID         — Backblaze B2 account ID
#   B2_ACCOUNT_KEY        — Backblaze B2 application key
# =============================================================================

BASE="${HOME}/aktenraum"
LOCAL_REPO="${BASE}/backup/restic-repo"
DBUSER="${PAPERLESS_DBUSER:-paperless}"
COMPOSE_DIR="$(cd "$(dirname "$0")/../docker" && pwd)"

export RESTIC_REPOSITORY="${LOCAL_REPO}"

log() { echo "[$(date -Iseconds)] $*"; }

# --------------------------------------------------------------------------
# Initialise local repo if needed
# --------------------------------------------------------------------------
if ! restic snapshots &>/dev/null; then
  log "Initialising restic repository at ${LOCAL_REPO}..."
  restic init
fi

# --------------------------------------------------------------------------
# Backup filesystem paths
# --------------------------------------------------------------------------
log "Backing up Paperless data directories..."
restic backup \
  "${BASE}/data" \
  "${BASE}/media" \
  "${BASE}/export" \
  --tag aktenraum \
  --tag filesystem

# --------------------------------------------------------------------------
# Backup postgres (piped directly — no temp file on disk)
# --------------------------------------------------------------------------
log "Backing up postgres database..."
docker compose -f "${COMPOSE_DIR}/docker-compose.yml" exec -T postgres \
  pg_dump -U "${DBUSER}" paperless \
  | restic backup \
      --stdin \
      --stdin-filename postgres.dump \
      --tag aktenraum \
      --tag postgres

# --------------------------------------------------------------------------
# Apply retention policy
# --------------------------------------------------------------------------
log "Applying retention policy..."
restic forget \
  --keep-daily   7 \
  --keep-weekly  4 \
  --keep-monthly 12 \
  --prune \
  --tag aktenraum

# --------------------------------------------------------------------------
# Optional: push to B2
# --------------------------------------------------------------------------
if [ -n "${BACKUP_B2_BUCKET:-}" ]; then
  if [ -z "${RESTIC_REPOSITORY_2:-}" ] || [ -z "${B2_ACCOUNT_ID:-}" ] || [ -z "${B2_ACCOUNT_KEY:-}" ]; then
    log "WARNING: BACKUP_B2_BUCKET is set but RESTIC_REPOSITORY_2 / B2_ACCOUNT_ID / B2_ACCOUNT_KEY are missing. Skipping remote backup."
  else
    log "Copying latest snapshot to B2..."
    RESTIC_REPOSITORY="${RESTIC_REPOSITORY_2}" \
    restic copy \
      --from-repo "${LOCAL_REPO}" \
      --tag aktenraum
    log "Applying B2 retention policy..."
    RESTIC_REPOSITORY="${RESTIC_REPOSITORY_2}" \
    restic forget \
      --keep-daily   7 \
      --keep-weekly  4 \
      --keep-monthly 12 \
      --prune \
      --tag aktenraum
  fi
else
  log "BACKUP_B2_BUCKET not set — skipping remote backup."
fi

log "Backup complete."
restic snapshots --tag aktenraum --last 3
