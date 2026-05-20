#!/usr/bin/env bash
set -euo pipefail

# Creates AI custom fields, tags, and (optionally) an IMAP mail account +
# rule in Paperless via the REST API. Safe to run multiple times — skips
# entities that already exist and reconciles drift on the ones that do.

PAPERLESS_URL="${PAPERLESS_BASE_URL:-http://localhost:8000}"
TOKEN="${PAPERLESS_API_TOKEN:?PAPERLESS_API_TOKEN is required}"

# Auto-load AKTENRAUM_MAIL_* from docker/.env if the caller didn't already
# export them. We only pick up keys we own — never override caller-provided
# env (so `FOO=bar bash scripts/bootstrap-paperless.sh` still wins).
ENV_FILE="${ENV_FILE:-docker/.env}"
if [ -f "${ENV_FILE}" ]; then
  while IFS='=' read -r key value; do
    case "${key}" in
      AKTENRAUM_MAIL_*)
        if [ -z "${!key:-}" ]; then
          value="${value%\"}"
          value="${value#\"}"
          value="${value%\'}"
          value="${value#\'}"
          export "${key}=${value}"
        fi
        ;;
    esac
  done < <(grep -E '^AKTENRAUM_MAIL_[A-Z_]+=' "${ENV_FILE}" 2>/dev/null || true)
fi

PYTHON="$(command -v python3 || command -v python || true)"
if [ -z "${PYTHON}" ]; then
  echo "Error: python3 or python is required on PATH" >&2
  exit 1
fi

AUTH_HEADER="Authorization: Token ${TOKEN}"
JSON_HEADER="Content-Type: application/json"

echo "Bootstrapping Paperless at ${PAPERLESS_URL}..."

# --------------------------------------------------------------------------
# Helper: get or create a custom field
# --------------------------------------------------------------------------
ensure_custom_field() {
  local name="$1"
  local data_type="$2"  # string | integer | float | date | boolean | url | documentlink | monetary | select

  # ?name__iexact= is the working exact-match filter; bare ?name= is silently
  # ignored on /api/tags/ and would return the default first page regardless,
  # producing false-negative existence checks once entity counts pass one page.
  # The Python-side equality check stays as defence in depth.
  existing=$(curl -sf \
    -H "${AUTH_HEADER}" \
    "${PAPERLESS_URL}/api/custom_fields/?name__iexact=${name}" \
    | "${PYTHON}" -c "import sys,json; r=json.load(sys.stdin); print(sum(1 for x in r['results'] if x['name']==sys.argv[1]))" "${name}")

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

  # ?name__iexact= is the working exact-match filter; bare ?name= is silently
  # ignored on /api/tags/ and would return the default first page regardless,
  # producing false-negative existence checks once entity counts pass one page.
  # The Python-side equality check stays as defence in depth.
  existing=$(curl -sf \
    -H "${AUTH_HEADER}" \
    "${PAPERLESS_URL}/api/tags/?name__iexact=${name}" \
    | "${PYTHON}" -c "import sys,json; r=json.load(sys.stdin); print(sum(1 for x in r['results'] if x['name']==sys.argv[1]))" "${name}")

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
ensure_custom_field "ai_title"            "string"
ensure_custom_field "ai_issue_date"       "date"
ensure_custom_field "ai_reference_numbers" "string"
ensure_custom_field "ai_suggested_tags"   "string"
ensure_custom_field "ai_summary_de"       "longtext"
ensure_custom_field "ai_confidence"       "float"
ensure_custom_field "ai_backend"          "string"
ensure_custom_field "ai_model"            "string"
# Surfaces the WHY behind ai-error / ai-propagation-error / ai-index-error
# so the SPA can show a real message instead of a bare "Fehler" pill.
# Long text so we never lose the tail of a stack trace.
ensure_custom_field "ai_error_message"    "longtext"
# One-sentence German explanation of what drove the confidence value
# (clear letterhead vs. fragmented OCR, ambiguous doc type, missing
# correspondent, etc.). Renders under the percentage in the review form
# so the user can decide whether to trust a low score.
ensure_custom_field "ai_confidence_reason" "longtext"

# --------------------------------------------------------------------------
# Tags
# --------------------------------------------------------------------------
echo
echo "Tags:"
ensure_tag "ai-pending"           "#f59e0b"  # amber  — extracted, awaiting review
ensure_tag "ai-approved"          "#22c55e"  # green  — approved, triggers propagation
ensure_tag "ai-auto-approved"     "#10b981"  # emerald — auxiliary: auto-approved via high confidence
ensure_tag "ai-rejected"          "#6b7280"  # gray   — rejected, no propagation
ensure_tag "ai-propagated"        "#3b82f6"  # blue   — native fields written
ensure_tag "ai-propagation-error" "#ef4444"  # red    — propagation failed mid-run
ensure_tag "ai-low-confidence"    "#fb923c"  # orange — review queue priority flag
ensure_tag "ai-error"             "#ef4444"  # red    — extraction failed
ensure_tag "ai-duplicate"         "#a855f7"  # purple — auxiliary: matched another propagated doc on key AI fields
ensure_tag "email-ingested"       "#0ea5e9"  # sky    — provenance: arrived via IMAP, not consume folder / upload

# --------------------------------------------------------------------------
# Email ingestion (optional)
#
# Provisioned only when AKTENRAUM_MAIL_IMAP_SERVER is set in the environment
# (or in docker/.env). Paperless polls the configured mailbox every ~10
# minutes, downloads attachments matching the rule, and feeds them through
# the same consumer pipeline as the consume/ folder — so the auto-tagger
# picks them up automatically and they land in the inbox for review.
# --------------------------------------------------------------------------

# Look up a single entity by name in a list endpoint. Returns id or empty.
# Paperless mail endpoints don't expose a `?name__iexact=` filter; we GET
# the (small) list and equality-check client-side.
lookup_id_by_name() {
  local endpoint="$1"  # e.g. mail_accounts
  local name="$2"

  curl -sf \
    -H "${AUTH_HEADER}" \
    "${PAPERLESS_URL}/api/${endpoint}/?page_size=200" \
    | "${PYTHON}" -c "import sys, json; r = json.load(sys.stdin); m = [x['id'] for x in r['results'] if x['name'] == sys.argv[1]]; print(m[0] if m else '')" \
      "${name}"
}

# Translate AKTENRAUM_MAIL_IMAP_SECURITY string → Paperless enum int.
# 1=NONE, 2=SSL (IMAPS), 3=STARTTLS. Default SSL (most common: Gmail,
# Outlook, Fastmail all use IMAPS on 993).
map_imap_security() {
  case "${1:-SSL}" in
    NONE|none|1)             echo 1 ;;
    SSL|ssl|IMAPS|imaps|2)   echo 2 ;;
    STARTTLS|starttls|3)     echo 3 ;;
    *)
      echo "Error: AKTENRAUM_MAIL_IMAP_SECURITY must be NONE | SSL | STARTTLS (got: ${1})" >&2
      exit 1
      ;;
  esac
}

# Translate AKTENRAUM_MAIL_ACTION string → Paperless enum int.
# Verified against Paperless 2.20.15: 1=DELETE, 3=MARK_READ (don't process
# read mails), 4=FLAG (don't process flagged mails). MOVE (2) / TAG (5)
# require an action_parameter we don't surface here. MARK_READ is the
# default — it effectively means "process once and never again" because
# Paperless's rule filter excludes read mail on the next poll.
map_mail_action() {
  case "${1:-MARK_READ}" in
    DELETE|delete|1)       echo 1 ;;
    MARK_READ|mark_read|3) echo 3 ;;
    FLAG|flag|4)           echo 4 ;;
    *)
      echo "Error: AKTENRAUM_MAIL_ACTION must be DELETE | MARK_READ | FLAG (got: ${1})" >&2
      exit 1
      ;;
  esac
}

ensure_mail_account() {
  local name="$1"
  local imap_server="$2"
  local imap_port="$3"
  local imap_security="$4"
  local username="$5"
  local password="$6"

  local existing_id
  existing_id=$(lookup_id_by_name "mail_accounts" "${name}")

  local body
  body=$("${PYTHON}" -c "import json,sys; print(json.dumps({'name':sys.argv[1],'imap_server':sys.argv[2],'imap_port':int(sys.argv[3]),'imap_security':int(sys.argv[4]),'username':sys.argv[5],'password':sys.argv[6],'character_set':'UTF-8','is_token':False}))" \
    "${name}" "${imap_server}" "${imap_port}" "${imap_security}" "${username}" "${password}")

  if [ -n "${existing_id}" ]; then
    # PATCH so password rotations stick. The password field is write-only —
    # we can't compare to detect drift, so we always send what config says.
    curl -sf -X PATCH \
      -H "${AUTH_HEADER}" \
      -H "${JSON_HEADER}" \
      -d "${body}" \
      "${PAPERLESS_URL}/api/mail_accounts/${existing_id}/" > /dev/null
    echo "  [updated] mail account: ${name} (id=${existing_id})" >&2
    echo "${existing_id}"
  else
    local created_id
    created_id=$(curl -sf -X POST \
      -H "${AUTH_HEADER}" \
      -H "${JSON_HEADER}" \
      -d "${body}" \
      "${PAPERLESS_URL}/api/mail_accounts/" \
      | "${PYTHON}" -c "import json,sys; print(json.load(sys.stdin)['id'])")
    echo "  [created] mail account: ${name} (id=${created_id})" >&2
    echo "${created_id}"
  fi
}

ensure_mail_rule() {
  local name="$1"
  local account_id="$2"
  local folder="$3"
  local action="$4"
  local filter_from="$5"
  local tag_id="$6"

  local existing_id
  existing_id=$(lookup_id_by_name "mail_rules" "${name}")

  # Field defaults — verified against Paperless 2.20.15 enums:
  #   consumption_scope=1     → attachments only (2=full eml, 3=both)
  #   attachment_type=2       → process all attachments incl. inline ones
  #                             that some clients embed (Outlook signatures
  #                             aside, inline-only embeds are how some
  #                             scanners send their output). 1 = real
  #                             attachments only.
  #   assign_title_from=2     → use the attachment filename (1=from_subject,
  #                             2=from_filename, 3=no title from rule);
  #                             attached PDFs usually arrive with a
  #                             meaningful name like "Rechnung_2024_03.pdf"
  #                             while subjects tend to be conversational
  #                             ("Re: Rechnung").
  #   filter_attachment_filename_include=*.pdf,*.png,*.jpg,*.jpeg,*.tif,*.tiff
  #                             → only consume what Paperless can OCR;
  #                             ignore signatures, logos, etc.
  #   maximum_age=30          → only look at mail from the last 30 days; on
  #                             first run avoids hammering the server with
  #                             years of history.
  local body
  body=$("${PYTHON}" -c "
import json, sys
name, account_id, folder, action, filter_from, tag_id = sys.argv[1:7]
rule = {
    'name': name,
    'account': int(account_id),
    'folder': folder,
    'action': int(action),
    'consumption_scope': 1,
    'attachment_type': 2,
    'assign_title_from': 2,
    'filter_attachment_filename_include': '*.pdf,*.png,*.jpg,*.jpeg,*.tif,*.tiff',
    'maximum_age': 30,
    'order': 0,
    'enabled': True,
}
if filter_from:
    rule['filter_from'] = filter_from
if tag_id:
    rule['assign_tags'] = [int(tag_id)]
print(json.dumps(rule))
" "${name}" "${account_id}" "${folder}" "${action}" "${filter_from}" "${tag_id}")

  if [ -n "${existing_id}" ]; then
    curl -sf -X PATCH \
      -H "${AUTH_HEADER}" \
      -H "${JSON_HEADER}" \
      -d "${body}" \
      "${PAPERLESS_URL}/api/mail_rules/${existing_id}/" > /dev/null
    echo "  [updated] mail rule: ${name} (id=${existing_id})"
  else
    curl -sf -X POST \
      -H "${AUTH_HEADER}" \
      -H "${JSON_HEADER}" \
      -d "${body}" \
      "${PAPERLESS_URL}/api/mail_rules/" > /dev/null
    echo "  [created] mail rule: ${name}"
  fi
}

echo
echo "Email ingestion (IMAP):"
if [ -z "${AKTENRAUM_MAIL_IMAP_SERVER:-}" ]; then
  echo "  [skip] AKTENRAUM_MAIL_IMAP_SERVER not set; mailbox ingestion disabled."
  echo "         Set it (plus AKTENRAUM_MAIL_USERNAME / AKTENRAUM_MAIL_PASSWORD)"
  echo "         in docker/.env and re-run this script to enable."
else
  : "${AKTENRAUM_MAIL_USERNAME:?AKTENRAUM_MAIL_USERNAME is required when AKTENRAUM_MAIL_IMAP_SERVER is set}"
  : "${AKTENRAUM_MAIL_PASSWORD:?AKTENRAUM_MAIL_PASSWORD is required when AKTENRAUM_MAIL_IMAP_SERVER is set}"

  MAIL_NAME="${AKTENRAUM_MAIL_NAME:-aktenraum}"
  MAIL_PORT="${AKTENRAUM_MAIL_IMAP_PORT:-993}"
  MAIL_SECURITY_INT="$(map_imap_security "${AKTENRAUM_MAIL_IMAP_SECURITY:-SSL}")"
  MAIL_FOLDER="${AKTENRAUM_MAIL_FOLDER:-INBOX}"
  MAIL_ACTION_INT="$(map_mail_action "${AKTENRAUM_MAIL_ACTION:-MARK_READ}")"
  MAIL_FILTER_FROM="${AKTENRAUM_MAIL_FILTER_FROM:-}"

  EMAIL_TAG_ID="$(lookup_id_by_name "tags" "email-ingested")"

  # ensure_mail_account echoes the id on stdout and progress lines on stderr.
  ACCOUNT_ID="$(ensure_mail_account "${MAIL_NAME}" "${AKTENRAUM_MAIL_IMAP_SERVER}" "${MAIL_PORT}" "${MAIL_SECURITY_INT}" "${AKTENRAUM_MAIL_USERNAME}" "${AKTENRAUM_MAIL_PASSWORD}")"
  ensure_mail_rule "${MAIL_NAME}-rule" "${ACCOUNT_ID}" "${MAIL_FOLDER}" "${MAIL_ACTION_INT}" "${MAIL_FILTER_FROM}" "${EMAIL_TAG_ID}"
fi

echo
echo "Bootstrap complete."
