#!/usr/bin/env bash
set -euo pipefail

# End-to-end test for the Node worker against a THROWAWAY Paperless stack
# (docker/docker-compose.e2e.yml, compose project "aktenraum-e2e").
#
# It never touches the live stack: separate project name, separate named
# volumes, separate ports. Running the Node worker against the live instance
# while the Python auto-tagger is up would race both workers on the same
# lifecycle tags and can double-propagate.
#
#   bash scripts/e2e-worker.sh          run the full flow
#   bash scripts/e2e-worker.sh --down   tear the stack down (deletes volumes)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "${REPO_ROOT}/docker/docker-compose.e2e.yml")

PAPERLESS_PORT="${E2E_PAPERLESS_PORT:-8100}"
WORKER_PORT="${E2E_WORKER_PORT:-8101}"
API_PORT="${E2E_API_PORT:-8102}"
QDRANT_PORT="${E2E_QDRANT_PORT:-6433}"
PAPERLESS="http://127.0.0.1:${PAPERLESS_PORT}"
API="http://127.0.0.1:${API_PORT}"
QDRANT="http://127.0.0.1:${QDRANT_PORT}"

PY="$(command -v python3 || command -v python)"

pass=0
fail=0
check() {
  local label="$1" ok="$2" detail="${3:-}"
  if [ "${ok}" = "1" ]; then
    printf '  \033[32mPASS\033[0m %s\n' "${label}"
    pass=$((pass + 1))
  else
    printf '  \033[31mFAIL\033[0m %s %s\n' "${label}" "${detail}"
    fail=$((fail + 1))
  fi
}

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

if [ "${1:-}" = "--down" ]; then
  step "Tearing down the e2e stack (volumes included)"
  "${COMPOSE[@]}" down -v --remove-orphans
  exit 0
fi

# --------------------------------------------------------------------------
# Guard: refuse to run if the ports collide with the live stack
# --------------------------------------------------------------------------
for port in "${PAPERLESS_PORT}" "${WORKER_PORT}" "${API_PORT}" "${QDRANT_PORT}"; do
  case "${port}" in
    8000|8002|8080|6333)
      echo "Refusing to run: port ${port} belongs to the live stack." >&2
      exit 1
      ;;
  esac
done

step "Starting the isolated Paperless snapshot"
"${COMPOSE[@]}" up -d --build postgres redis gotenberg tika qdrant paperless

step "Waiting for Paperless to serve"
for _ in $(seq 1 120); do
  if curl -sf -o /dev/null "${PAPERLESS}/api/"; then break; fi
  sleep 5
done
curl -sf -o /dev/null "${PAPERLESS}/api/" || { echo "Paperless never came up" >&2; exit 1; }

step "Minting an API token on the throwaway database"
TOKEN="$(curl -sf -X POST "${PAPERLESS}/api/token/" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"e2epassword"}' \
  | "${PY}" -c "import sys,json; print(json.load(sys.stdin)['token'])")"
[ -n "${TOKEN}" ] || { echo "Token minting failed" >&2; exit 1; }
export E2E_PAPERLESS_API_TOKEN="${TOKEN}"

step "Bootstrapping custom fields + lifecycle tags"
ENV_FILE=/dev/null \
PAPERLESS_BASE_URL="${PAPERLESS}" \
PAPERLESS_API_TOKEN="${TOKEN}" \
  bash "${REPO_ROOT}/scripts/bootstrap-paperless.sh" >/dev/null

step "Starting aktenraum-api-node + worker-node"
"${COMPOSE[@]}" up -d --build aktenraum-api-node worker-node

step "Waiting for the worker's webhook listener"
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:${WORKER_PORT}/health"; then break; fi
  sleep 2
done
check "worker /health responds" \
  "$(curl -sf -o /dev/null "http://127.0.0.1:${WORKER_PORT}/health" && echo 1 || echo 0)"

step "Waiting for the API and enabling auto-approve for Rechnung"
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "${API}/api/health"; then break; fi
  sleep 2
done
COOKIE_JAR="$(mktemp)"
trap 'rm -f "${COOKIE_JAR}"' EXIT
curl -sf -c "${COOKIE_JAR}" -X POST "${API}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"e2epassword"}' >/dev/null

RULES_JSON="$(curl -sf -b "${COOKIE_JAR}" "${API}/api/settings/auto-approve" \
  | "${PY}" -c "
import sys, json
rules = json.load(sys.stdin)['rules']
out = []
for r in rules:
    enabled = r['document_type'] == 'Rechnung'
    out.append({'document_type': r['document_type'],
                'enabled': enabled,
                'min_confidence': 0.5 if enabled else 0.9})
print(json.dumps({'rules': out}))
")"
curl -sf -b "${COOKIE_JAR}" -X PUT "${API}/api/settings/auto-approve" \
  -H "Content-Type: application/json" -d "${RULES_JSON}" >/dev/null
check "auto-approve rule for Rechnung enabled" \
  "$(curl -sf -b "${COOKIE_JAR}" "${API}/api/settings/auto-approve" \
     | "${PY}" -c "
import sys, json
r = [x for x in json.load(sys.stdin)['rules'] if x['document_type'] == 'Rechnung'][0]
print(1 if r['enabled'] else 0)")"

step "Uploading a German invoice"
# Paperless dedups by SHA1, so a re-run against an already-populated stack
# would be silently dropped. Make the invoice unique per run.
RUN_ID="$(date +%y%m%d%H%M%S)"
INVOICE_NO="RE-2026-${RUN_ID}"
DOC_FILE="$(mktemp -d)/rechnung-e2e.txt"
cat > "${DOC_FILE}" <<DOC
Stadtwerke Musterstadt GmbH
Energieweg 12, 12345 Musterstadt

RECHNUNG

Rechnungsnummer: ${INVOICE_NO}
Kundennummer: KD-4711
Rechnungsdatum: 15.03.2026
Faelligkeitsdatum: 29.03.2026
Abrechnungszeitraum: 01.01.2026 bis 28.02.2026

Position 1: Stromlieferung Grundversorgung    248,50 EUR
Position 2: Grundpreis                         41,49 EUR

Gesamtbetrag brutto: 289,99 EUR

Bitte ueberweisen Sie den Betrag bis zum Faelligkeitsdatum auf das
untenstehende Konto. Bei Rueckfragen nennen Sie bitte Ihre Kundennummer.
DOC

TASK_ID="$(curl -sf -X POST "${PAPERLESS}/api/documents/post_document/" \
  -H "Authorization: Token ${TOKEN}" \
  -F "document=@${DOC_FILE};type=text/plain" \
  | tr -d '"')"
check "Paperless accepted the upload" "$([ -n "${TASK_ID}" ] && echo 1 || echo 0)" "task=${TASK_ID}"

step "Waiting for consumption (webhook fires from post_consume)"
DOC_ID=""
for _ in $(seq 1 90); do
  DOC_ID="$(curl -sf -H "Authorization: Token ${TOKEN}" \
    "${PAPERLESS}/api/tasks/?task_id=${TASK_ID}" \
    | "${PY}" -c "
import sys, json, re
rows = json.load(sys.stdin)
rows = rows.get('results', rows) if isinstance(rows, dict) else rows
if not rows: print(''); raise SystemExit
row = rows[0]
doc = row.get('related_document')
if not doc:
    m = re.search(r'document id (\d+)', str(row.get('result') or ''))
    doc = m.group(1) if m else ''
print(doc or '')" 2>/dev/null || echo "")"
  [ -n "${DOC_ID}" ] && break
  sleep 2
done
check "document was consumed" "$([ -n "${DOC_ID}" ] && echo 1 || echo 0)" "doc_id=${DOC_ID}"
[ -n "${DOC_ID}" ] || { echo "Cannot continue without a document id" >&2; exit 1; }

fetch_doc() {
  curl -sf -H "Authorization: Token ${TOKEN}" "${PAPERLESS}/api/documents/${DOC_ID}/"
}

tag_names() {
  curl -sf -H "Authorization: Token ${TOKEN}" "${PAPERLESS}/api/tags/?page_size=200" \
    | "${PY}" -c "
import sys, json
print(json.dumps({t['id']: t['name'] for t in json.load(sys.stdin)['results']}))"
}

step "Waiting for extraction + propagation to finish (doc ${DOC_ID})"
TAGS_ON_DOC=""
for _ in $(seq 1 150); do
  TAG_MAP="$(tag_names)"
  TAGS_ON_DOC="$(fetch_doc | "${PY}" -c "
import sys, json
doc = json.load(sys.stdin)
names = json.loads(sys.argv[1])
print(' '.join(sorted(names.get(str(t), names.get(t, str(t))) for t in doc.get('tags', []))))
" "${TAG_MAP}")"
  case " ${TAGS_ON_DOC} " in
    *" ai-propagated "*|*" ai-error "*|*" ai-propagation-error "*|*" ai-rejected "*) break ;;
  esac
  sleep 4
done
echo "     tags: ${TAGS_ON_DOC}"

case " ${TAGS_ON_DOC} " in
  *" ai-propagated "*) check "reached ai-propagated" 1 ;;
  *) check "reached ai-propagated" 0 "got: ${TAGS_ON_DOC}" ;;
esac
case " ${TAGS_ON_DOC} " in
  *" ai-auto-approved "*) check "routing auto-approved the Rechnung" 1 ;;
  *) check "routing auto-approved the Rechnung" 0 "got: ${TAGS_ON_DOC}" ;;
esac

step "Checking extracted AI fields"
FIELD_MAP="$(curl -sf -H "Authorization: Token ${TOKEN}" \
  "${PAPERLESS}/api/custom_fields/?page_size=200" \
  | "${PY}" -c "
import sys, json
print(json.dumps({f['id']: f['name'] for f in json.load(sys.stdin)['results']}))")"
DOC_JSON="$(fetch_doc)"
read_field() {
  echo "${DOC_JSON}" | "${PY}" -c "
import sys, json
doc = json.load(sys.stdin)
names = json.loads(sys.argv[1])
want = sys.argv[2]
for cf in doc.get('custom_fields', []):
    if names.get(str(cf['field']), names.get(cf['field'])) == want:
        print(cf['value'] if cf['value'] is not None else '')
        break
else:
    print('')
" "${FIELD_MAP}" "$1"
}

for field in ai_document_type ai_correspondent ai_title ai_summary_de ai_confidence ai_issue_date; do
  value="$(read_field "${field}")"
  check "${field} is populated" "$([ -n "${value}" ] && echo 1 || echo 0)" "value=${value}"
done
check "ai_document_type is Rechnung" \
  "$([ "$(read_field ai_document_type)" = "Rechnung" ] && echo 1 || echo 0)" \
  "got=$(read_field ai_document_type)"
REFS="$(read_field ai_reference_numbers)"
REFS_OK=0
case "${REFS}" in *"${INVOICE_NO}"*) REFS_OK=1 ;; esac
check "ai_reference_numbers found the invoice number" "${REFS_OK}" "got=${REFS}"

step "Checking propagation to native Paperless fields"
NATIVE="$(echo "${DOC_JSON}" | "${PY}" -c "
import sys, json
doc = json.load(sys.stdin)
print(json.dumps({'correspondent': doc.get('correspondent'),
                  'document_type': doc.get('document_type'),
                  'created': doc.get('created')}))")"
echo "     native: ${NATIVE}"
check "native correspondent set" \
  "$(echo "${NATIVE}" | "${PY}" -c "import sys,json; print(1 if json.load(sys.stdin)['correspondent'] else 0)")"
check "native document_type set" \
  "$(echo "${NATIVE}" | "${PY}" -c "import sys,json; print(1 if json.load(sys.stdin)['document_type'] else 0)")"
check "native created date is the invoice date, not today" \
  "$(echo "${NATIVE}" | "${PY}" -c "
import sys, json
print(1 if str(json.load(sys.stdin)['created'] or '').startswith('2026-03-15') else 0)")"

step "Checking RAG indexing into Qdrant"
CHUNKS=""
for _ in $(seq 1 60); do
  CHUNKS="$(curl -sf -X POST "${QDRANT}/collections/aktenraum_chunks/points/count" \
    -H "Content-Type: application/json" \
    -d "{\"filter\":{\"must\":[{\"key\":\"doc_id\",\"match\":{\"value\":${DOC_ID}}}]},\"exact\":true}" \
    | "${PY}" -c "import sys,json; print(json.load(sys.stdin)['result']['count'])" 2>/dev/null || echo "")"
  [ -n "${CHUNKS}" ] && [ "${CHUNKS}" != "0" ] && break
  sleep 3
done
check "document was chunked and embedded into Qdrant" \
  "$([ -n "${CHUNKS}" ] && [ "${CHUNKS}" != "0" ] && echo 1 || echo 0)" "chunks=${CHUNKS}"
case " ${TAGS_ON_DOC} " in
  *" ai-index-error "*) check "no indexing error tag" 0 ;;
  *) check "no indexing error tag" 1 ;;
esac

step "Checking duplicate detection on a re-upload"
DUP_FILE="$(dirname "${DOC_FILE}")/rechnung-e2e-kopie.txt"
sed 's/Position 2: Grundpreis                         41,49 EUR/Position 2: Grundpreis (Kopie)                   41,49 EUR/' \
  "${DOC_FILE}" > "${DUP_FILE}"
DUP_TASK="$(curl -sf -X POST "${PAPERLESS}/api/documents/post_document/" \
  -H "Authorization: Token ${TOKEN}" \
  -F "document=@${DUP_FILE};type=text/plain" | tr -d '"')"
DUP_ID=""
for _ in $(seq 1 90); do
  DUP_ID="$(curl -sf -H "Authorization: Token ${TOKEN}" \
    "${PAPERLESS}/api/tasks/?task_id=${DUP_TASK}" \
    | "${PY}" -c "
import sys, json, re
rows = json.load(sys.stdin)
rows = rows.get('results', rows) if isinstance(rows, dict) else rows
if not rows: print(''); raise SystemExit
row = rows[0]
doc = row.get('related_document')
if not doc:
    m = re.search(r'document id (\d+)', str(row.get('result') or ''))
    doc = m.group(1) if m else ''
print(doc or '')" 2>/dev/null || echo "")"
  [ -n "${DUP_ID}" ] && break
  sleep 2
done

DUP_TAGS=""
if [ -n "${DUP_ID}" ]; then
  for _ in $(seq 1 150); do
    TAG_MAP="$(tag_names)"
    DUP_TAGS="$(curl -sf -H "Authorization: Token ${TOKEN}" "${PAPERLESS}/api/documents/${DUP_ID}/" \
      | "${PY}" -c "
import sys, json
doc = json.load(sys.stdin)
names = json.loads(sys.argv[1])
print(' '.join(sorted(names.get(str(t), names.get(t, str(t))) for t in doc.get('tags', []))))
" "${TAG_MAP}")"
    case " ${DUP_TAGS} " in
      *" ai-propagated "*|*" ai-error "*|*" ai-propagation-error "*) break ;;
    esac
    sleep 4
  done
  echo "     duplicate doc ${DUP_ID} tags: ${DUP_TAGS}"
fi
case " ${DUP_TAGS} " in
  *" ai-duplicate "*) check "second filing flagged as a duplicate" 1 ;;
  *) check "second filing flagged as a duplicate" 0 "got: ${DUP_TAGS}" ;;
esac

step "Result"
printf '  %d passed, %d failed\n' "${pass}" "${fail}"
if [ "${fail}" -gt 0 ]; then
  echo
  echo "Worker logs (last 60 lines):"
  "${COMPOSE[@]}" logs --tail=60 worker-node
fi
echo
echo "Stack is still up for inspection. Tear it down with:"
echo "  bash scripts/e2e-worker.sh --down"
[ "${fail}" -eq 0 ]
