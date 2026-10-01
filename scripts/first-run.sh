#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKER_DIR="${ROOT}/docker"
ENV_FILE="${DOCKER_DIR}/.env"
COMPOSE=(docker compose --project-directory "${DOCKER_DIR}")
export MSYS_NO_PATHCONV=1

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

env_value() {
  grep -E "^$1=" "${ENV_FILE}" 2>/dev/null | tail -1 | cut -d= -f2- || true
}

set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  if grep -qE "^${key}=" "${ENV_FILE}"; then
    awk -v k="${key}" -v v="${value}" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' "${ENV_FILE}" > "${tmp}"
  else
    cat "${ENV_FILE}" > "${tmp}"
    printf '%s=%s\n' "${key}" "${value}" >> "${tmp}"
  fi
  cat "${tmp}" > "${ENV_FILE}"
  rm -f "${tmp}"
}

default_data_dir() {
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*)
      if command -v cygpath >/dev/null 2>&1 && [ -n "${USERPROFILE:-}" ]; then
        printf '%s/aktenraum' "$(cygpath -m "${USERPROFILE}")"
      else
        printf 'C:/aktenraum'
      fi
      ;;
    *) printf '%s/aktenraum' "${HOME}" ;;
  esac
}

is_absolute() {
  case "$1" in
    /* | [A-Za-z]:/*) return 0 ;;
    *) return 1 ;;
  esac
}

step "Checking prerequisites"
command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start Docker Desktop and run this again."
docker compose version >/dev/null 2>&1 || die "'docker compose' is missing. Update Docker Desktop."
command -v openssl >/dev/null 2>&1 || die "openssl is missing (it ships with Git Bash on Windows and with macOS)."
command -v curl >/dev/null 2>&1 || die "curl is missing."
ok "Docker is running"

step "Creating docker/.env"
if [ ! -f "${ENV_FILE}" ]; then
  cp "${DOCKER_DIR}/.env.example" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  ok "created from docker/.env.example"
else
  ok "already exists — existing values are kept"
fi

step "Choosing where your documents are stored"
DATA_DIR="$(env_value AKTENRAUM_DATA_DIR)"
if [ -z "${DATA_DIR}" ]; then
  DATA_DIR="$(default_data_dir)"
  if [ -t 0 ]; then
    printf '  Folder for documents, databases and backups [%s]: ' "${DATA_DIR}"
    read -r answer || answer=""
    [ -n "${answer}" ] && DATA_DIR="${answer//\\//}"
  fi
  is_absolute "${DATA_DIR}" || die "'${DATA_DIR}' is not an absolute path (e.g. /Users/you/aktenraum or C:/aktenraum)."
  set_env AKTENRAUM_DATA_DIR "${DATA_DIR}"
fi
ok "AKTENRAUM_DATA_DIR=${DATA_DIR}"

step "Generating secrets"
bash "${ROOT}/scripts/bootstrap-secrets.sh"

step "Creating the data folders"
bash "${ROOT}/scripts/setup.sh" >/dev/null
ok "folders ready under ${DATA_DIR}"

step "Checking the local AI (Ollama)"
OLLAMA_HOST_URL="${OLLAMA_HOST_URL:-http://localhost:11434}"
if [ "$(env_value LLM_BACKEND)" = "ollama" ]; then
  curl -sf "${OLLAMA_HOST_URL}/api/tags" >/dev/null \
    || die "Ollama is not reachable at ${OLLAMA_HOST_URL}. Install it from https://ollama.com, start it, and run this again."
  for key in OLLAMA_MODEL EMBEDDING_MODEL; do
    model="$(env_value "${key}")"
    [ -z "${model}" ] && continue
    if curl -sf "${OLLAMA_HOST_URL}/api/tags" | grep -q "\"name\":\"${model}\""; then
      ok "${model} is already installed"
    else
      echo "  downloading ${model} (several GB, this can take a while)…"
      if command -v ollama >/dev/null 2>&1; then
        ollama pull "${model}"
      else
        curl -sfN "${OLLAMA_HOST_URL}/api/pull" -d "{\"name\":\"${model}\"}" | tail -1
      fi
      ok "${model} installed"
    fi
  done
else
  ok "LLM_BACKEND=$(env_value LLM_BACKEND) — skipping Ollama"
fi

step "Building and starting aktenraum (first time takes several minutes)"
"${COMPOSE[@]}" up -d --build --remove-orphans

step "Connecting the AI services to Paperless"
bash "${ROOT}/scripts/fix-token.sh"

step "Creating the AI fields and tags in Paperless"
TOKEN="$(env_value PAPERLESS_API_TOKEN)"
[ -n "${TOKEN}" ] || die "No Paperless token was created. Run 'task recover' and then this script again."
for _ in $(seq 1 60); do
  code="$("${COMPOSE[@]}" exec -T paperless curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Token ${TOKEN}" http://localhost:8000/api/custom_fields/ 2>/dev/null || true)"
  [ "${code}" = "200" ] && break
  sleep 5
done
[ "${code}" = "200" ] || die "Paperless does not accept the new token (HTTP ${code:-none}). Run 'task recover', then this script again."
"${COMPOSE[@]}" cp "${ROOT}/scripts/bootstrap-paperless.sh" paperless:/tmp/bootstrap-paperless.sh
"${COMPOSE[@]}" exec -T -e PAPERLESS_API_TOKEN="${TOKEN}" paperless bash /tmp/bootstrap-paperless.sh

step "Waiting until every service is healthy"
for _ in $(seq 1 60); do
  waiting="$("${COMPOSE[@]}" ps --format '{{.Service}} {{.Status}}' | grep -E 'starting|unhealthy|Restarting' | grep -v '^backup ' || true)"
  [ -z "${waiting}" ] && break
  sleep 5
done
[ -z "${waiting}" ] || die "Still not healthy after 5 minutes:
${waiting}
Check the logs with: docker logs docker-<service>-1"
ok "all services are up"

step "Setting up backups"
"${COMPOSE[@]}" exec -T backup sh -c 'restic -r /repo cat config >/dev/null 2>&1 || restic -r /repo init'
"${COMPOSE[@]}" exec -T backup //usr/local/bin/entrypoint.sh
"${COMPOSE[@]}" exec -T -e RESTIC_REPOSITORY=/repo backup //usr/local/bin/verify-backup.sh

USERNAME="$(env_value BOOTSTRAP_USERNAME)"
PASSWORD="$(env_value BOOTSTRAP_PASSWORD)"
printf '\n\033[1;32m✓ aktenraum is ready\033[0m\n\n'
printf '  Open:      http://localhost:8080\n'
printf '  Username:  %s\n' "${USERNAME:-admin}"
printf '  Password:  %s\n' "${PASSWORD}"
printf '\n  Documents, databases and backups live in: %s\n' "${DATA_DIR}"
printf '  All passwords are in docker/.env — back that file up somewhere safe.\n'
printf '  Show the login again any time with:  task login\n\n'
