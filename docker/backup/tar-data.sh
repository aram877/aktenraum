#!/usr/bin/env bash
set -uo pipefail

tar -C /backup -cf - \
    --exclude='data/log' \
    --exclude='*.lock' \
    --exclude='data/migration_lock' \
    --warning=no-file-changed \
    --warning=no-file-removed \
    data media export
status=$?
if [ "${status}" -le 1 ]; then
  exit 0
fi
exit "${status}"
