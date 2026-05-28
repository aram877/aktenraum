#!/usr/bin/env bash
set -euo pipefail

: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is required}"
: "${PAPERLESS_DBPASS:?PAPERLESS_DBPASS is required}"

DBUSER="${PAPERLESS_DBUSER:-paperless}"
export RESTIC_REPOSITORY=/repo
export PGPASSWORD="${PAPERLESS_DBPASS}"

log() { echo "[$(date -Iseconds)] $*"; }

# --------------------------------------------------------------------------
# Init repo if needed
# --------------------------------------------------------------------------
if ! restic snapshots &>/dev/null; then
    log "Initialising restic repository..."
    restic init
fi

# --------------------------------------------------------------------------
# Backup data directories
# --------------------------------------------------------------------------
log "Backing up Paperless data directories..."
restic backup \
    /backup/data \
    /backup/media \
    /backup/export \
    --tag aktenraum \
    --tag filesystem

# --------------------------------------------------------------------------
# Backup postgres via direct connection
# --------------------------------------------------------------------------
log "Backing up paperless database..."
pg_dump -h postgres -U "${DBUSER}" paperless \
    | restic backup \
        --stdin \
        --stdin-filename postgres.dump \
        --tag aktenraum \
        --tag postgres

log "Backing up aktenraum database..."
pg_dump -h postgres -U "${DBUSER}" aktenraum \
    | restic backup \
        --stdin \
        --stdin-filename aktenraum.dump \
        --tag aktenraum \
        --tag postgres-aktenraum

# --------------------------------------------------------------------------
# Retention policy
# --------------------------------------------------------------------------
log "Applying retention policy..."
restic forget \
    --keep-daily   7 \
    --keep-weekly  4 \
    --keep-monthly 12 \
    --prune \
    --tag aktenraum

# --------------------------------------------------------------------------
# Optional B2 remote
# --------------------------------------------------------------------------
if [ -n "${BACKUP_B2_BUCKET:-}" ]; then
    if [ -z "${RESTIC_REPOSITORY_2:-}" ] || [ -z "${B2_ACCOUNT_ID:-}" ] || [ -z "${B2_ACCOUNT_KEY:-}" ]; then
        log "WARNING: BACKUP_B2_BUCKET set but B2 credentials incomplete — skipping remote backup."
    else
        log "Copying snapshot to B2..."
        RESTIC_REPOSITORY="${RESTIC_REPOSITORY_2}" \
        restic copy --from-repo /repo --tag aktenraum
        RESTIC_REPOSITORY="${RESTIC_REPOSITORY_2}" \
        restic forget \
            --keep-daily 7 --keep-weekly 4 --keep-monthly 12 \
            --prune --tag aktenraum
    fi
fi

log "Backup complete."
restic snapshots --tag aktenraum --latest 3
