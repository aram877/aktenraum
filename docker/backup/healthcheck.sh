#!/usr/bin/env bash
set -euo pipefail

MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-36}"
export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-/repo}"

if [ -z "${RESTIC_PASSWORD:-}" ]; then
  echo "RESTIC_PASSWORD is not set — nightly backups cannot run"
  exit 1
fi

now="$(date +%s)"
report=""
for tag in filesystem postgres postgres-aktenraum; do
  latest="$(restic snapshots --no-lock --tag "${tag}" --latest 1 --json 2>&1)" || {
    echo "cannot open restic repository: ${latest}"
    exit 1
  }
  when="$(printf '%s' "$latest" | jq -r 'map(.time) | max // empty')"
  if [ -z "$when" ]; then
    echo "no ${tag} snapshot in ${RESTIC_REPOSITORY}"
    exit 1
  fi
  taken="$(date -d "$(printf '%s' "$when" | cut -c1-19 | tr 'T' ' ')" +%s)"
  age_hours=$(( (now - taken) / 3600 ))
  if [ "$age_hours" -gt "$MAX_AGE_HOURS" ]; then
    echo "latest ${tag} snapshot is ${age_hours}h old (limit ${MAX_AGE_HOURS}h)"
    exit 1
  fi
  report="${report} ${tag}=${age_hours}h"
done
echo "backups fresh:${report}"
