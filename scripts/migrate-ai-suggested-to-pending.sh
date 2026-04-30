#!/usr/bin/env bash
set -euo pipefail

# One-time migration: rename ai-suggested → ai-pending on all documents.
# Safe to run multiple times — skips docs that already have ai-pending.

PAPERLESS_URL="${PAPERLESS_BASE_URL:-http://localhost:8000}"
TOKEN="${PAPERLESS_API_TOKEN:?PAPERLESS_API_TOKEN is required}"

PYTHON="$(command -v python3 || command -v python || true)"
if [ -z "${PYTHON}" ]; then
  echo "Error: python3 or python is required on PATH" >&2
  exit 1
fi

AUTH="-H \"Authorization: Token ${TOKEN}\""
JSON="-H \"Content-Type: application/json\""

_get() { curl -sf -H "Authorization: Token ${TOKEN}" "$@"; }
_patch() { curl -sf -X PATCH -H "Authorization: Token ${TOKEN}" -H "Content-Type: application/json" "$@"; }

echo "=== migrate ai-suggested → ai-pending ==="
echo "Paperless: ${PAPERLESS_URL}"
echo

# --------------------------------------------------------------------------
# Resolve tag IDs
# --------------------------------------------------------------------------
SUGGESTED_ID=$(_get "${PAPERLESS_URL}/api/tags/?name=ai-suggested" \
  | "${PYTHON}" -c "import sys,json; r=json.load(sys.stdin); t=[x for x in r['results'] if x['name']=='ai-suggested']; print(t[0]['id'] if t else '')")

if [ -z "${SUGGESTED_ID}" ]; then
  echo "No ai-suggested tag found — nothing to migrate."
  exit 0
fi

PENDING_ID=$(_get "${PAPERLESS_URL}/api/tags/?name=ai-pending" \
  | "${PYTHON}" -c "import sys,json; r=json.load(sys.stdin); t=[x for x in r['results'] if x['name']=='ai-pending']; print(t[0]['id'] if t else '')")

if [ -z "${PENDING_ID}" ]; then
  echo "ERROR: ai-pending tag not found. Run bootstrap-paperless.sh first."
  exit 1
fi

echo "ai-suggested ID: ${SUGGESTED_ID}"
echo "ai-pending ID:   ${PENDING_ID}"
echo

# --------------------------------------------------------------------------
# Find all documents with ai-suggested tag
# --------------------------------------------------------------------------
PAGE=1
TOTAL=0
MIGRATED=0

while true; do
  RESPONSE=$(_get "${PAPERLESS_URL}/api/documents/?tags__id__all=${SUGGESTED_ID}&page_size=25&page=${PAGE}")
  COUNT=$(echo "$RESPONSE" | "${PYTHON}" -c "import sys,json; print(json.load(sys.stdin)['count'])")
  DOCS=$(echo "$RESPONSE" | "${PYTHON}" -c "import sys,json; d=json.load(sys.stdin); [print(doc['id'], json.dumps(doc['tags'])) for doc in d['results']]")

  [ -z "$DOCS" ] && break
  TOTAL=$COUNT

  while IFS= read -r line; do
    DOC_ID=$(echo "$line" | awk '{print $1}')
    CURRENT_TAGS=$(echo "$line" | sed "s/^${DOC_ID} //")

    # Build new tag list: replace suggested with pending, keep others
    NEW_TAGS=$(echo "$CURRENT_TAGS" | "${PYTHON}" -c "
import sys, json
tags = json.load(sys.stdin)
tags = [t for t in tags if t != ${SUGGESTED_ID}]
if ${PENDING_ID} not in tags:
    tags.append(${PENDING_ID})
print(json.dumps(tags))
")
    _patch "${PAPERLESS_URL}/api/documents/${DOC_ID}/" \
      -d "{\"tags\": ${NEW_TAGS}}" > /dev/null
    echo "  doc ${DOC_ID}: migrated"
    MIGRATED=$((MIGRATED + 1))
  done <<< "$DOCS"

  # Check if there are more pages
  HAS_NEXT=$(echo "$RESPONSE" | "${PYTHON}" -c "import sys,json; d=json.load(sys.stdin); print('yes' if d.get('next') else 'no')")
  [ "$HAS_NEXT" = "no" ] && break
  PAGE=$((PAGE + 1))
done

echo
echo "Done. Migrated ${MIGRATED} / ${TOTAL} documents from ai-suggested → ai-pending."
