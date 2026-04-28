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
echo "  1. cp docker/.env.example docker/.env  — fill in REQUIRED values"
echo "  2. cp docker/auto-tagger.env.example docker/auto-tagger.env  — fill in REQUIRED values"
echo "  3. cd docker && docker compose up -d"
echo "  4. bash scripts/bootstrap-paperless.sh"
