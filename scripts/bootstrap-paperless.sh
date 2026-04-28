#!/usr/bin/env bash
set -euo pipefail

# Creates AI custom fields and tags in Paperless via the REST API.
# Safe to run multiple times — skips fields/tags that already exist.

PAPERLESS_URL="${PAPERLESS_BASE_URL:-http://localhost:8000}"
TOKEN="${PAPERLESS_API_TOKEN:?PAPERLESS_API_TOKEN is required}"

AUTH_HEADER="Authorization: Token ${TOKEN}"
JSON_HEADER="Content-Type: application/json"

echo "Bootstrapping Paperless at ${PAPERLESS_URL}..."

# --------------------------------------------------------------------------
# Helper: get or create a custom field
# --------------------------------------------------------------------------
ensure_custom_field() {
  local name="$1"
  local data_type="$2"  # string | integer | float | date | boolean | url | documentlink | monetary | select

  existing=$(curl -sf \
    -H "${AUTH_HEADER}" \
    "${PAPERLESS_URL}/api/custom_fields/?name=${name}" \
    | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['count'])")

  if [ "${existing}" -gt 0 ]; then
    echo "  [skip] custom field already exists: ${name}"
  else
    curl -sf -X POST \
      -H "${AUTH_HEADER}" \
      -H "${JSON_HEADER}" \
      -d "{\"name\": \"${name}\", \"data_type\": \"${data_type}\"}" \
      "${PAPERLESS_URL}/api/custom_fields/" > /dev/null
    echo "  [created] custom field: ${name} (${data_type})"
  fi
}

# --------------------------------------------------------------------------
# Helper: get or create a tag
# --------------------------------------------------------------------------
ensure_tag() {
  local name="$1"
  local color="${2:-}"

  existing=$(curl -sf \
    -H "${AUTH_HEADER}" \
    "${PAPERLESS_URL}/api/tags/?name=${name}" \
    | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['count'])")

  if [ "${existing}" -gt 0 ]; then
    echo "  [skip] tag already exists: ${name}"
  else
    local body="{\"name\": \"${name}\"}"
    if [ -n "${color}" ]; then
      body="{\"name\": \"${name}\", \"color\": \"${color}\"}"
    fi
    curl -sf -X POST \
      -H "${AUTH_HEADER}" \
      -H "${JSON_HEADER}" \
      -d "${body}" \
      "${PAPERLESS_URL}/api/tags/" > /dev/null
    echo "  [created] tag: ${name}"
  fi
}

# --------------------------------------------------------------------------
# Custom fields
# --------------------------------------------------------------------------
echo
echo "Custom fields:"
ensure_custom_field "ai_document_type"    "string"
ensure_custom_field "ai_correspondent"    "string"
ensure_custom_field "ai_issue_date"       "date"
ensure_custom_field "ai_due_date"         "date"
ensure_custom_field "ai_expiry_date"      "date"
ensure_custom_field "ai_monetary_amount"  "monetary"
ensure_custom_field "ai_reference_numbers" "string"
ensure_custom_field "ai_suggested_tags"   "string"
ensure_custom_field "ai_summary_de"       "string"
ensure_custom_field "ai_confidence"       "float"
ensure_custom_field "ai_backend"          "string"
ensure_custom_field "ai_model"            "string"

# --------------------------------------------------------------------------
# Tags
# --------------------------------------------------------------------------
echo
echo "Tags:"
ensure_tag "ai-suggested" "#f59e0b"
ensure_tag "ai-error"     "#ef4444"

echo
echo "Bootstrap complete."
