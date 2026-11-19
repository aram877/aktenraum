#!/usr/bin/env bash
# Runs hourly from crond and once at container start. Starts a backup only
# when the newest complete backup (the OLDEST of the three per-tag latest
# snapshots) is older than BACKUP_INTERVAL_HOURS (default 20).
#
# Why not a fixed "0 2 * * *": on a desktop that sleeps at night the job never
# fired — BusyBox crond does not catch up missed runs. On 2026-11-19 the repo
# held 20 snapshots, none taken by cron, the newest 34 days old. Catch-up
# scheduling backs up within an hour of the machine being awake, whenever that is.
#
# Concurrency: entrypoint.sh holds an flock, so a manual run and this script
# can never back up at the same time.
set -uo pipefail

INTERVAL_HOURS="${BACKUP_INTERVAL_HOURS:-20}"
export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-/repo}"

log() { echo "[$(date -Iseconds)] $*"; }

oldest=""
unreadable=""
for tag in filesystem postgres postgres-aktenraum; do
  json="$(restic snapshots --no-lock --tag "${tag}" --latest 1 --json 2>/dev/null)" || { unreadable="cannot read the restic repository"; break; }
  when="$(printf '%s' "${json}" | jq -r 'map(.time) | max // empty')"
  if [ -z "${when}" ]; then
    unreadable="no ${tag} snapshot yet"
    break
  fi
  taken="$(date -d "$(printf '%s' "${when}" | cut -c1-19 | tr 'T' ' ')" +%s)"
  if [ -z "${oldest}" ] || [ "${taken}" -lt "${oldest}" ]; then
    oldest="${taken}"
  fi
done

if [ -n "${unreadable}" ]; then
  # entrypoint.sh reports the real cause loudly (missing password, missing repo, ...)
  log "Backup due (${unreadable}) — starting."
  exec /usr/local/bin/entrypoint.sh
fi

age_hours=$(( ($(date +%s) - oldest) / 3600 ))
if [ "${age_hours}" -lt "${INTERVAL_HOURS}" ]; then
  exit 0
fi

log "Backup due (newest complete backup is ${age_hours}h old, interval ${INTERVAL_HOURS}h) — starting."
exec /usr/local/bin/entrypoint.sh
