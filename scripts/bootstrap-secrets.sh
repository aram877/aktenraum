#!/usr/bin/env bash
# bootstrap-secrets.sh — first-run secret generation, idempotent.
#
# Per ADR-002 the desktop-app distribution shape requires that buyers never
# need to edit env files. This script is the first piece of Phase 0: it copies
# the committed `.env.example` template to `docker/.env` (if it doesn't exist
# yet) and fills every empty REQUIRED secret with a freshly generated value.
# Re-runs are no-ops once everything is populated, which lets the desktop shell
# call this on every launch as a safety net.
#
# Idempotency rules
#   - Existing non-empty values are NEVER overwritten.
#   - The script ONLY prints credentials it generated this run — never on a
#     no-op pass — so re-runs don't leak passwords into logs.
#
# Out of scope (handled by later Phase-0 pieces):
#   - PAPERLESS_API_TOKEN: must be minted via the Paperless API AFTER the
#     paperless container starts. See `scripts/bootstrap-paperless.sh`.
#   - Provider-specific keys (ANTHROPIC_API_KEY): user-supplied, not
#     generated. The desktop shell prompts for these.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKER_DIR="${ROOT}/docker"
ENV_FILE="${DOCKER_DIR}/.env"

declare -a generated_lines=()

# ---- helpers ---------------------------------------------------------------

# `openssl rand` is portable across macOS, Linux, Git Bash, WSL.
gen_secret_b64() {
  openssl rand -base64 32 | tr -d '\n='
}

gen_secret_hex() {
  openssl rand -hex 32
}

# Random alphanumeric password — friendlier to display in a UI than base64
# (no '+', '/', '=' that get URL-encoded or copy-pasted oddly).
gen_password() {
  openssl rand -base64 24 | tr -d '\n=+/' | head -c 24
}

# Read the value for KEY from FILE. Returns empty string if KEY is absent
# OR present-but-empty. We treat both as "needs filling."
read_value() {
  local file="$1" key="$2"
  if [[ ! -f "$file" ]]; then
    echo ""
    return
  fi
  local line
  line="$(grep -E "^${key}=" "$file" | head -n1 || true)"
  if [[ -z "$line" ]]; then
    echo ""
    return
  fi
  echo "${line#${key}=}"
}

# Write KEY=VALUE in FILE. If KEY already exists, replace its line; otherwise
# append. Uses an in-place edit via a temp file (portable across GNU/BSD sed).
write_value() {
  local file="$1" key="$2" value="$3"
  local tmp
  tmp="$(mktemp)"
  if [[ -f "$file" ]] && grep -qE "^${key}=" "$file"; then
    local escaped
    escaped="$(printf '%s' "$value" | sed -e 's/[\\&|]/\\&/g')"
    sed "s|^${key}=.*|${key}=${escaped}|" "$file" > "$tmp"
    mv "$tmp" "$file"
  else
    [[ -f "$file" ]] || touch "$file"
    if [[ -s "$file" ]] && [[ "$(tail -c1 "$file" 2>/dev/null)" != $'\n' ]]; then
      printf '\n' >> "$file"
    fi
    printf '%s=%s\n' "$key" "$value" >> "$file"
    rm -f "$tmp"
  fi
}

# Fill KEY in ENV_FILE with a freshly generated value if currently empty.
# Returns 0 if the key was filled, 1 if already populated.
fill_if_empty() {
  local key="$1" generator="$2"
  local current
  current="$(read_value "$ENV_FILE" "$key")"
  if [[ -n "$current" ]]; then
    return 1
  fi
  local value
  value="$("$generator")"
  write_value "$ENV_FILE" "$key" "$value"
  return 0
}

# ---- main ------------------------------------------------------------------

echo "→ aktenraum bootstrap-secrets.sh"
echo

# 1. Ensure the runtime env file exists (copy from template if absent).
if [[ ! -f "$ENV_FILE" ]]; then
  local_example="${DOCKER_DIR}/.env.example"
  if [[ -f "$local_example" ]]; then
    cp "$local_example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "created ${ENV_FILE} from template"
  else
    touch "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "created empty ${ENV_FILE} (no template found)"
  fi
fi

# 2. Generate unique secrets.

if fill_if_empty PAPERLESS_SECRET_KEY gen_secret_hex; then
  generated_lines+=("Paperless framework secret key: generated ✓")
fi

if fill_if_empty JWT_SECRET gen_secret_b64; then
  generated_lines+=("aktenraum-api JWT signing key: generated ✓")
fi

if fill_if_empty RESTIC_PASSWORD gen_password; then
  RESTIC_PW="$(read_value "$ENV_FILE" RESTIC_PASSWORD)"
  generated_lines+=("Restic backup passphrase: ${RESTIC_PW}")
  generated_lines+=("  ⚠ Without this passphrase your backups CANNOT be restored. Save it now.")
fi

if fill_if_empty PAPERLESS_DBPASS gen_password; then
  generated_lines+=("Postgres password (paperless user): generated ✓")
fi

if fill_if_empty WEBHOOK_SECRET gen_secret_b64; then
  generated_lines+=("Internal webhook secret: generated ✓")
fi

# 3. User-facing passwords — print in plaintext exactly once if generated.

if fill_if_empty PAPERLESS_ADMIN_PASSWORD gen_password; then
  PW="$(read_value "$ENV_FILE" PAPERLESS_ADMIN_PASSWORD)"
  generated_lines+=("Paperless admin login (http://localhost:8000):")
  generated_lines+=("  username: $(read_value "$ENV_FILE" PAPERLESS_ADMIN_USER || echo admin)")
  generated_lines+=("  password: ${PW}")
fi

if fill_if_empty BOOTSTRAP_PASSWORD gen_password; then
  PW="$(read_value "$ENV_FILE" BOOTSTRAP_PASSWORD)"
  generated_lines+=("aktenraum SPA login (http://localhost:8080):")
  generated_lines+=("  username: $(read_value "$ENV_FILE" BOOTSTRAP_USERNAME || echo admin)")
  generated_lines+=("  password: ${PW}")
fi

# 4. Final report.

if (( ${#generated_lines[@]} == 0 )); then
  echo "✓ All secrets already populated. No changes made."
  exit 0
fi

echo "✓ Bootstrap complete. New credentials generated this run:"
echo
for line in "${generated_lines[@]}"; do
  echo "  $line"
done
echo
echo "Record the user-visible passwords above NOW — they are not printed again."
echo "File updated: ${ENV_FILE}"
echo
echo "Next: cd docker && docker compose up -d"
echo "Then: scripts/bootstrap-paperless.sh   (mints the API token + custom fields)"
