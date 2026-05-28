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
  if [ "${BACKUP_AUTO_INIT:-false}" = "true" ]; then
    log "No repository at ${LOCAL_REPO} — BACKUP_AUTO_INIT=true, initialising..."
    restic init
  else
    log "ERROR: no restic repository at ${LOCAL_REPO}."
    log "Refusing to auto-create one: if the data dir drifted, auto-init would silently"
    log "abandon the existing repo. First-time setup: run 'task setup', or set"
    log "BACKUP_AUTO_INIT=true for this run if you really intend a new repository here."
    exit 1
  fi
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
log "Backing up paperless database..."
docker compose -f "${COMPOSE_DIR}/docker-compose.yml" exec -T postgres \
  pg_dump -U "${DBUSER}" paperless \
  | restic backup \
      --stdin \
      --stdin-filename postgres.dump \
      --tag aktenraum \
      --tag postgres

log "Backing up aktenraum database..."
docker compose -f "${COMPOSE_DIR}/docker-compose.yml" exec -T postgres \
  pg_dump -U "${DBUSER}" aktenraum \
  | restic backup \
      --stdin \
      --stdin-filename aktenraum.dump \
      --tag aktenraum \
      --tag postgres-aktenraum

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

    log "Verifying B2 copy..."
    if command -v jq >/dev/null 2>&1; then
      local_n="$(restic -r "${LOCAL_REPO}" snapshots --tag aktenraum --json | jq 'length')"
      b2_n="$(RESTIC_REPOSITORY="${RESTIC_REPOSITORY_2}" restic snapshots --tag aktenraum --json | jq 'length')"
      if [ "${b2_n}" -lt "${local_n}" ]; then
        log "ERROR: B2 has ${b2_n} aktenraum snapshots but local has ${local_n} — remote copy is incomplete."
        exit 1
      fi
      log "B2 copy verified: ${b2_n} snapshots on remote (local ${local_n})."
    else
      log "jq not found — skipping B2 snapshot-count verification."
    fi
  fi
else
  log "BACKUP_B2_BUCKET not set — skipping remote backup."
fi

log "Backup complete."
restic snapshots --tag aktenraum --latest 3
