#!/usr/bin/env bash
# Docker healthcheck (hourly) — also the writer of the status file the
# aktenraum-api serves at GET /api/health/backup, so the SPA can warn when
# backups are stale instead of the warning living only in `docker compose ps`.
set -uo pipefail

MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-36}"
STATUS_DIR="${BACKUP_STATUS_DIR:-/status}"
export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-/repo}"

iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

oldest=""

finish() {
  local healthy="$1" message="$2"
  echo "${message}"
  if [ -d "${STATUS_DIR}" ] && [ -w "${STATUS_DIR}" ]; then
    local latest_iso="" run_at="" run_exit=""
    [ -n "${oldest}" ] && latest_iso="$(iso "${oldest}")"
    if [ -f "${STATUS_DIR}/last-run" ]; then
      read -r run_at run_exit < "${STATUS_DIR}/last-run" || true
    fi
    jq -n \
      --arg checked_at "$(iso "$(date +%s)")" \
      --argjson healthy "${healthy}" \
      --arg message "${message}" \
      --arg latest "${latest_iso}" \
      --argjson max_age "${MAX_AGE_HOURS}" \
      --arg run_at "${run_at}" \
      --arg run_exit "${run_exit}" \
      '{
        checked_at: $checked_at,
        healthy: $healthy,
        message: $message,
        latest_snapshot_at: (if $latest == "" then null else $latest end),
        max_age_hours: $max_age,
        last_run_at: (if $run_at == "" then null else $run_at end),
        last_run_exit: (if $run_exit == "" then null else ($run_exit | tonumber) end)
      }' > "${STATUS_DIR}/.backup-status.json.tmp" \
      && mv "${STATUS_DIR}/.backup-status.json.tmp" "${STATUS_DIR}/backup-status.json"
  fi
  if [ "${healthy}" = "true" ]; then exit 0; else exit 1; fi
}

if [ -z "${RESTIC_PASSWORD:-}" ]; then
  finish false "RESTIC_PASSWORD is not set — backups cannot run"
fi

now="$(date +%s)"
report=""
stale=""
for tag in filesystem postgres postgres-aktenraum; do
  latest="$(restic snapshots --no-lock --tag "${tag}" --latest 1 --json 2>&1)" || {
    finish false "cannot open restic repository: ${latest}"
  }
  when="$(printf '%s' "${latest}" | jq -r 'map(.time) | max // empty')"
  if [ -z "${when}" ]; then
    finish false "no ${tag} snapshot in ${RESTIC_REPOSITORY}"
  fi
  taken="$(date -d "$(printf '%s' "${when}" | cut -c1-19 | tr 'T' ' ')" +%s)"
  if [ -z "${oldest}" ] || [ "${taken}" -lt "${oldest}" ]; then
    oldest="${taken}"
  fi
  age_hours=$(( (now - taken) / 3600 ))
  if [ "${age_hours}" -gt "${MAX_AGE_HOURS}" ] && [ -z "${stale}" ]; then
    stale="latest ${tag} snapshot is ${age_hours}h old (limit ${MAX_AGE_HOURS}h)"
  fi
  report="${report} ${tag}=${age_hours}h"
done

if [ -n "${stale}" ]; then
  finish false "${stale}"
fi
finish true "backups fresh:${report}"
