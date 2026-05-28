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
    if [ "${BACKUP_AUTO_INIT:-false}" = "true" ]; then
        log "No repository at ${RESTIC_REPOSITORY} — BACKUP_AUTO_INIT=true, initialising..."
        restic init
    else
        log "ERROR: no restic repository at ${RESTIC_REPOSITORY}."
        log "Refusing to auto-create one: if AKTENRAUM_DATA_DIR drifted to a new path,"
        log "auto-init would silently abandon the existing repo and start a fresh, empty"
        log "backup history. First-time setup: run 'task setup', or set BACKUP_AUTO_INIT=true"
        log "for this one run if you really intend to create a new repository here."
        exit 1
    fi
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

        log "Verifying B2 copy..."
        local_n="$(restic -r /repo snapshots --tag aktenraum --json | jq 'length')"
        b2_n="$(restic -r "${RESTIC_REPOSITORY_2}" snapshots --tag aktenraum --json | jq 'length')"
        if [ "${b2_n}" -lt "${local_n}" ]; then
            log "ERROR: B2 has ${b2_n} aktenraum snapshots but local has ${local_n} — remote copy is incomplete."
            exit 1
        fi
        log "B2 copy verified: ${b2_n} snapshots on remote (local ${local_n})."
    fi
fi

# --------------------------------------------------------------------------
# Integrity check — weekly (Sundays) to bound cost; structure + 5% of data
# --------------------------------------------------------------------------
if [ "$(date +%u)" = "7" ] || [ "${BACKUP_FORCE_CHECK:-false}" = "true" ]; then
    log "Running restic check (structure + 5% data sample)..."
    restic check --read-data-subset=5%
    log "restic check passed."
fi

log "Backup complete."
restic snapshots --tag aktenraum --latest 3
