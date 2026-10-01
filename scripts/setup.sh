#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/docker/.env"
BASE="${AKTENRAUM_DATA_DIR:-}"
if [ -z "${BASE}" ] && [ -f "${ENV_FILE}" ]; then
  BASE="$(grep '^AKTENRAUM_DATA_DIR=' "${ENV_FILE}" | tail -1 | cut -d= -f2-)"
fi
if [ -z "${BASE}" ]; then
  echo "ERROR: AKTENRAUM_DATA_DIR is not set. Put an absolute path in docker/.env first." >&2
  exit 1
fi

echo "Creating aktenraum host directories under ${BASE}..."

dirs=(
  consume
  media
  data
  export
  pgdata
  qdrant
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
