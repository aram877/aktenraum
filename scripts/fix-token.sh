#!/usr/bin/env bash
# fix-token.sh — Mint a fresh Paperless API token and write it into both
# env files. Run this whenever you see 401 errors from auto-tagger or
# aktenraum-api, or after any postgres recreation.
#
# Usage: bash scripts/fix-token.sh
# Or:    task recover

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKER_DIR="${ROOT}/docker"

ADMIN_USER=$(grep '^PAPERLESS_ADMIN_USER=' "${DOCKER_DIR}/.env" | cut -d= -f2- || echo "admin")
ADMIN_PASS=$(grep '^PAPERLESS_ADMIN_PASSWORD=' "${DOCKER_DIR}/.env" | cut -d= -f2-)

if [ -z "${ADMIN_PASS}" ]; then
    echo "ERROR: PAPERLESS_ADMIN_PASSWORD not found in docker/.env" >&2
    exit 1
fi

# ---- wait for Paperless -------------------------------------------------------

echo "→ Waiting for Paperless to be ready..."
attempts=0
until docker compose --project-directory "${DOCKER_DIR}" exec -T paperless \
    curl -sf http://localhost:8000/api/ > /dev/null 2>&1; do
    sleep 3
    attempts=$((attempts + 1))
    if [ $attempts -ge 20 ]; then
        echo "ERROR: Paperless did not come up after 60s. Is the stack running?" >&2
        echo "  Run: task start" >&2
        exit 1
    fi
done
echo "  Paperless is up."

# ---- mint token ---------------------------------------------------------------

echo "→ Minting new API token..."
RESPONSE=$(docker compose --project-directory "${DOCKER_DIR}" exec -T paperless \
    curl -s -X POST http://localhost:8000/api/token/ \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}")

NEW_TOKEN=$(echo "${RESPONSE}" | grep -o '"token":"[^"]*"' | cut -d'"' -f4 || true)

if [ -z "${NEW_TOKEN}" ]; then
    echo "ERROR: Failed to mint token. Response: ${RESPONSE}" >&2
    echo "Check PAPERLESS_ADMIN_USER / PAPERLESS_ADMIN_PASSWORD in docker/.env" >&2
    exit 1
fi

echo "  Got token: ${NEW_TOKEN:0:8}… (truncated)"

# ---- write token into both env files (safe: uses temp file, no sed -i risk) --

write_token() {
    local file="$1"
    if [ ! -f "${file}" ]; then
        echo "  SKIP: ${file} not found"
        return
    fi
    local tmp
    tmp="$(mktemp)"
    if grep -q "^PAPERLESS_API_TOKEN=" "${file}"; then
        sed "s|^PAPERLESS_API_TOKEN=.*|PAPERLESS_API_TOKEN=${NEW_TOKEN}|" "${file}" > "${tmp}"
    else
        cat "${file}" > "${tmp}"
        echo "PAPERLESS_API_TOKEN=${NEW_TOKEN}" >> "${tmp}"
    fi
    mv "${tmp}" "${file}"
    echo "  Updated ${file}"
}

write_token "${DOCKER_DIR}/auto-tagger.env"
write_token "${DOCKER_DIR}/aktenraum-api.env"

# ---- restart affected services -----------------------------------------------

echo "→ Restarting auto-tagger and aktenraum-api..."
docker compose --project-directory "${DOCKER_DIR}" up -d auto-tagger aktenraum-api
echo "  Done."
echo ""
echo "✓ Token rotation complete. 401 errors should stop within a few seconds."
