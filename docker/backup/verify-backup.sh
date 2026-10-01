#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# verify-backup.sh — non-destructive disaster-recovery rehearsal.
#
# Proves a backup is actually recoverable WITHOUT touching live data:
#   1. restic check       — repository integrity (structure + 5% data sample)
#   2. filesystem restore  — tar stream into a throwaway staging dir; asserts
#                            at least one original document came back
#   3. both DB dumps       — restic dump each stream; asserts non-empty + looks
#                            like a pg_dump (paperless AND aktenraum)
#
# Exits non-zero on the first failure so it is usable as a gate. For an actual
# in-place restore see docs/runbooks/restore.md.
# =============================================================================

: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is required}"
export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-/repo}"

SNAPSHOT="${1:-latest}"
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/aktenraum-verify.XXXXXX")"
trap 'rm -rf "${STAGING}"' EXIT

log()  { echo "[verify] $*"; }
fail() { echo "[verify] FAIL: $*" >&2; exit 1; }

log "Repository: ${RESTIC_REPOSITORY}"

# 1. Repository integrity --------------------------------------------------
log "restic check (structure + 5% data sample)..."
restic check --retry-lock 2m --read-data-subset=5% || fail "restic check reported repository errors"

# 2. Filesystem restorability ---------------------------------------------
log "Restoring filesystem snapshot (${SNAPSHOT}) to staging..."
mkdir -p "${STAGING}/fs"
restic dump --tag filesystem "${SNAPSHOT}" aktenraum-files.tar 2>/dev/null \
    | tar -x -C "${STAGING}/fs" \
    || fail "filesystem restore failed (no aktenraum-files.tar under tag filesystem?)"
originals="$(find "${STAGING}/fs/media/documents/originals" -type f 2>/dev/null | wc -l | tr -d ' ')"
live="$(find /backup/media/documents/originals -type f 2>/dev/null | wc -l | tr -d ' ')"
if [ "${live}" -gt 0 ] && [ "${originals}" -eq 0 ]; then
    fail "filesystem restore contains 0 original documents but ${live} exist"
fi
fs_files="$(find "${STAGING}/fs" -type f | wc -l | tr -d ' ')"
log "Filesystem restore OK: ${fs_files} files, ${originals} original documents."

# 3. Database dumps --------------------------------------------------------
# tag : stdin-filename : human label
for spec in "postgres:postgres.dump:paperless" \
            "postgres-aktenraum:aktenraum.dump:aktenraum"; do
    tag="${spec%%:*}"; rest="${spec#*:}"; file="${rest%%:*}"; db="${rest##*:}"
    log "Validating ${db} DB dump (tag ${tag}, file ${file})..."
    out="${STAGING}/${file}"
    restic dump --tag "${tag}" "${SNAPSHOT}" "${file}" > "${out}" 2>/dev/null \
        || fail "no ${file} under tag ${tag} — the ${db} DB is NOT in this backup"
    [ -s "${out}" ] || fail "${file} restored empty"
    grep -qiE 'PostgreSQL database dump|CREATE TABLE|^COPY ' "${out}" \
        || fail "${file} does not look like a pg_dump"
    log "${db} DB dump OK ($(wc -c < "${out}" | tr -d ' ') bytes)."
done

log "PASS — repo integrity OK, filesystem restorable, both DB dumps valid."
