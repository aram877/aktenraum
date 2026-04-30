#!/usr/bin/env bash
# One-shot migration: convert the `ai_summary_de` custom field from `string`
# (128-char limit) to `longtext` (no length limit).
#
# Paperless does NOT allow changing a custom-field's data_type after creation,
# so we drop the existing field and recreate it. The 128-char ellipsis-clipped
# values on already-classified docs are lost — use the SPA's "Erneut
# verarbeiten" (or POST /api/documents/{id}/reprocess) on any doc you want a
# fresh full-length summary on.
#
# Usage:
#   PAPERLESS_BASE_URL=http://localhost:8000 \
#   PAPERLESS_API_TOKEN=<token> \
#     ./scripts/migrate-ai-summary-to-longtext.sh
#
# Or just run from the repo root with docker/auto-tagger.env in place — the
# script reads the token from there as a fallback.

set -euo pipefail

BASE_URL="${PAPERLESS_BASE_URL:-http://localhost:8000}"
TOKEN="${PAPERLESS_API_TOKEN:-}"

if [[ -z "$TOKEN" && -f docker/auto-tagger.env ]]; then
  TOKEN="$(grep '^PAPERLESS_API_TOKEN=' docker/auto-tagger.env | cut -d= -f2-)"
fi

if [[ -z "$TOKEN" ]]; then
  echo "ERROR: PAPERLESS_API_TOKEN is not set and could not be read from docker/auto-tagger.env" >&2
  exit 1
fi

PY="$(command -v python3 || command -v python)"
if [[ -z "$PY" ]]; then
  echo "ERROR: python3 / python not found" >&2
  exit 1
fi

api() {
  curl -s -H "Authorization: Token ${TOKEN}" "$@"
}

echo "Looking up the existing ai_summary_de custom field…"
EXISTING="$(api "${BASE_URL}/api/custom_fields/?page_size=200" \
  | $PY -c "import sys, json; \
results = json.load(sys.stdin)['results']; \
match = next((f for f in results if f['name'] == 'ai_summary_de'), None); \
print(json.dumps(match) if match else 'null')")"

if [[ "$EXISTING" == "null" ]]; then
  echo "No existing ai_summary_de field — creating fresh as longtext."
else
  ID="$(echo "$EXISTING" | $PY -c "import sys, json; print(json.load(sys.stdin)['id'])")"
  TYPE="$(echo "$EXISTING" | $PY -c "import sys, json; print(json.load(sys.stdin)['data_type'])")"
  if [[ "$TYPE" == "longtext" ]]; then
    echo "ai_summary_de is already longtext — nothing to do."
    exit 0
  fi
  echo "Found ai_summary_de id=$ID data_type=$TYPE — deleting (this drops all current summary values)…"
  STATUS=$(api -o /dev/null -w "%{http_code}" -X DELETE "${BASE_URL}/api/custom_fields/${ID}/")
  if [[ "$STATUS" != "204" ]]; then
    echo "ERROR: delete returned HTTP $STATUS" >&2
    exit 1
  fi
fi

echo "Creating ai_summary_de as longtext…"
RESP=$(api -X POST -H "Content-Type: application/json" \
  "${BASE_URL}/api/custom_fields/" \
  -d '{"name":"ai_summary_de","data_type":"longtext"}')
echo "$RESP" | $PY -m json.tool

echo
echo "Done. Summaries on already-classified documents are now empty."
echo "Use the SPA's 'Erneut verarbeiten' button (or POST /api/documents/{id}/reprocess)"
echo "on any doc you want a full-length summary on."
