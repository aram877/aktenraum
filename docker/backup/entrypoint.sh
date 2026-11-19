#!/usr/bin/env bash
set -euo pipefail

: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is required}"
: "${PAPERLESS_DBPASS:?PAPERLESS_DBPASS is required}"

DBUSER="${PAPERLESS_DBUSER:-paperless}"
: "${RESTIC_REPOSITORY:=/repo}"
export RESTIC_REPOSITORY
export PGPASSWORD="${PAPERLESS_DBPASS}"

log() { echo "[$(date -Iseconds)] $*"; }

STATUS_DIR="${BACKUP_STATUS_DIR:-/status}"

# --------------------------------------------------------------------------
# One run at a time — cron (backup-if-due.sh), container start and manual
# `docker compose exec backup entrypoint.sh` all come through here.
# --------------------------------------------------------------------------
exec 9>/tmp/aktenraum-backup.lock
if ! flock -n 9; then
    log "Another backup run is in progress — skipping."
    exit 0
fi

# Record the outcome (timestamp + exit code) and refresh the status file the
# SPA reads, also when `set -e` aborts the run halfway.
record_run() {
    local rc=$?
    if [ -d "${STATUS_DIR}" ] && [ -w "${STATUS_DIR}" ]; then
        printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${rc}" > "${STATUS_DIR}/last-run"
        /usr/local/bin/healthcheck.sh >/dev/null 2>&1 || true
    fi
    if [ "${rc}" -ne 0 ]; then
        log "ERROR: backup run failed (exit ${rc})."
    fi
}
trap record_run EXIT

# --------------------------------------------------------------------------
# Init repo if needed
# --------------------------------------------------------------------------
if ! snapshots_error="$(restic snapshots --no-lock 2>&1 >/dev/null)"; then
    # A repo that exists but cannot be opened (wrong RESTIC_PASSWORD, damaged
    # key, permissions) used to be reported as "no restic repository" — which
    # sends the operator looking for a missing folder instead of a bad password.
    if [ -f "${RESTIC_REPOSITORY}/config" ]; then
        log "ERROR: the restic repository at ${RESTIC_REPOSITORY} exists but cannot be opened:"
        log "  ${snapshots_error}"
        log "Most likely RESTIC_PASSWORD in docker/.env is not the password this repository"
        log "was created with. Do NOT re-initialise: that would abandon every existing snapshot."
        exit 1
    fi
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

log "Backing up Paperless data directories..."
restic backup \
    --stdin-from-command \
    --stdin-filename aktenraum-files.tar \
    --tag aktenraum \
    --tag filesystem \
    -- /usr/local/bin/tar-data.sh

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
# Integrity check — at most weekly to bound cost; structure + 5% of data.
# Keyed on "7 days since the last check" (marker in the status volume), not
# on "today is Sunday": a desktop that is never on during a Sunday run would
# otherwise never be checked. Without the status volume it falls back to Sundays.
# --------------------------------------------------------------------------
CHECK_MARKER="${STATUS_DIR}/last-check"
check_due() {
    [ "${BACKUP_FORCE_CHECK:-false}" = "true" ] && return 0
    if [ ! -d "${STATUS_DIR}" ] || [ ! -w "${STATUS_DIR}" ]; then
        [ "$(date +%u)" = "7" ]
        return
    fi
    [ -f "${CHECK_MARKER}" ] || return 0
    local last
    last="$(cat "${CHECK_MARKER}" 2>/dev/null || echo 0)"
    [ $(( $(date +%s) - ${last:-0} )) -ge $(( 7 * 86400 )) ]
}
if check_due; then
    log "Running restic check (structure + 5% data sample)..."
    restic check --read-data-subset=5%
    log "restic check passed."
    if [ -d "${STATUS_DIR}" ] && [ -w "${STATUS_DIR}" ]; then
        date +%s > "${CHECK_MARKER}"
    fi
fi

log "Backup complete."
restic snapshots --tag aktenraum --latest 3
