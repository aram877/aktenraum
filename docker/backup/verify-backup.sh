#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# verify-backup.sh — non-destructive disaster-recovery rehearsal.
#
# Proves a backup is actually recoverable WITHOUT touching live data:
#   1. restic check       — repository integrity (structure + 5% data sample)
#   2. filesystem restore  — into a throwaway staging dir; asserts >0 files
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
restic check --read-data-subset=5% || fail "restic check reported repository errors"

# 2. Filesystem restorability ---------------------------------------------
log "Restoring filesystem snapshot (${SNAPSHOT}) to staging..."
restic restore "${SNAPSHOT}" --tag filesystem --target "${STAGING}/fs" >/dev/null \
    || fail "filesystem restore failed (no filesystem-tagged snapshot?)"
fs_files="$(find "${STAGING}/fs" -type f | wc -l | tr -d ' ')"
[ "${fs_files}" -gt 0 ] || fail "filesystem restore produced 0 files — snapshot paths likely wrong"
log "Filesystem restore OK: ${fs_files} files."

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
