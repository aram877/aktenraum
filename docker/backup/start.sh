#!/usr/bin/env bash
# Container entry point (CMD). Writes the status file right away so the SPA
# has something to show, catches up a missed backup shortly after start
# (Docker Desktop restarts the containers when the machine wakes), then hands
# PID 1 to crond, which runs backup-if-due.sh hourly.
set -u

/usr/local/bin/healthcheck.sh >/dev/null 2>&1 || true

(
  sleep "${BACKUP_START_DELAY_SECONDS:-60}"
  /usr/local/bin/backup-if-due.sh
) >> /proc/1/fd/1 2>&1 &

exec crond -f -l 2
