#!/bin/sh
# Paperless-ngx post-consume hook → notify the auto-tagger HTTP listener.
#
# Paperless runs this script inside the paperless container after each
# document finishes consuming. We POST the document id to auto-tagger so
# extraction starts within seconds instead of waiting for the next 30s poll.
#
# This is best-effort. If the auto-tagger is down, unreachable, or just slow,
# we MUST NOT cause Paperless to fail the document — the polling loop is the
# safety net. So we swallow any error and exit 0.
#
# Paperless documents the env vars it provides:
#   https://docs.paperless-ngx.com/advanced_usage/#post-consumption-script

if [ -z "${DOCUMENT_ID:-}" ]; then
  exit 0
fi

curl -sS --max-time 5 \
  -H "Content-Type: application/json" \
  -H "X-Aktenraum-Secret: ${AKTENRAUM_WEBHOOK_SECRET:-}" \
  -d "{\"document_id\": ${DOCUMENT_ID}}" \
  http://auto-tagger:8001/trigger/extract \
  >/dev/null 2>&1 || true
