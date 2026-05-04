#!/usr/bin/env bash
set -euo pipefail

BASE="${HOME}/aktenraum"

echo "Creating aktenraum host directories under ${BASE}..."

dirs=(
  consume
  media
  data
  export
  pgdata
  backup/restic-repo
)

for d in "${dirs[@]}"; do
  mkdir -p "${BASE}/${d}"
  echo "  created ${BASE}/${d}"
done

# Paperless consume directory must be world-writable so the container can drop files
chmod 777 "${BASE}/consume"

echo
echo "Done. Next steps:"
echo "  1. bash scripts/bootstrap-secrets.sh  — generates all required secrets"
echo "  2. cd docker && docker compose up -d"
echo "  3. bash scripts/bootstrap-paperless.sh  — mints API token + custom fields"
