#!/usr/bin/env bash
# bootstrap-secrets.sh — first-run secret generation, idempotent.
#
# Per ADR-002 the desktop-app distribution shape requires that buyers never
# need to edit env files. This script is the first piece of Phase 0: it copies
# committed `.env.example` templates into runtime `.env` files (if they don't
# exist yet) and fills in every empty REQUIRED secret with a freshly generated
# value. Re-runs are no-ops once everything is populated, which lets the
# desktop shell call this on every launch as a safety net.
#
# Idempotency rules
#   - Existing non-empty values are NEVER overwritten.
#   - Cross-file shared secrets (PAPERLESS_DBPASS, WEBHOOK_SECRET) are
#     reconciled: if any file already has a value, every file gets that value;
#     if none do, a single fresh value is generated and written to all.
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

declare -a generated_lines=()

# ---- helpers ---------------------------------------------------------------

# `openssl rand` is portable across macOS, Linux, Git Bash, WSL. We avoid
# `/dev/urandom` directly to keep the script behaviour identical across those.
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
  # ^KEY=  on its own line; trim a trailing comment if present
  local line
  line="$(grep -E "^${key}=" "$file" | head -n1 || true)"
  if [[ -z "$line" ]]; then
    echo ""
    return
  fi
  # Strip "KEY=" and trim wrapping whitespace.
  echo "${line#${key}=}"
}

# Write KEY=VALUE in FILE. If KEY already exists, replace its line; otherwise
# append. Uses an in-place edit via a temp file to keep this portable across
# GNU and BSD sed (their -i semantics differ).
write_value() {
  local file="$1" key="$2" value="$3"
  local tmp
  tmp="$(mktemp)"
  if [[ -f "$file" ]] && grep -qE "^${key}=" "$file"; then
    # Existing line — rewrite. Escape `&`, `|`, and `\` because we use them
    # in the sed delimiter / replacement.
    local escaped
    escaped="$(printf '%s' "$value" | sed -e 's/[\\&|]/\\&/g')"
    sed "s|^${key}=.*|${key}=${escaped}|" "$file" > "$tmp"
    mv "$tmp" "$file"
  else
    # New line — append. Preserve a trailing newline at the end of the file.
    [[ -f "$file" ]] || touch "$file"
    if [[ -s "$file" ]] && [[ "$(tail -c1 "$file" 2>/dev/null)" != $'\n' ]]; then
      printf '\n' >> "$file"
    fi
    printf '%s=%s\n' "$key" "$value" >> "$file"
    rm -f "$tmp"
  fi
}

# Copy `<name>.env.example` → `<name>.env` if the target doesn't exist.
ensure_runtime_file() {
  local name="$1"
  local target="${DOCKER_DIR}/${name}.env"
  local source="${DOCKER_DIR}/${name}.env.example"
  if [[ -f "$target" ]]; then
    return
  fi
  if [[ ! -f "$source" ]]; then
    echo "warn: no template at ${source}; skipping ${target}" >&2
    return
  fi
  cp "$source" "$target"
  # The template's filemode may be readable to others; secrets shouldn't be.
  chmod 600 "$target"
  echo "created ${target} from template"
}

# Fill KEY in FILE with a freshly generated VALUE if currently empty. Returns
# 0 if the key was filled (i.e. the script changed state), 1 if it was
# already populated.
fill_if_empty() {
  local file="$1" key="$2" generator="$3"
  local current
  current="$(read_value "$file" "$key")"
  if [[ -n "$current" ]]; then
    return 1
  fi
  local value
  value="$("$generator")"
  write_value "$file" "$key" "$value"
  return 0
}

# Reconcile a shared secret across multiple files. If any file already has a
# value, every file gets that value. Otherwise generate one. Prints the
# resulting value on stdout if it was newly generated; empty otherwise.
reconcile_shared() {
  local key="$1" generator="$2"
  shift 2
  local files=("$@")

  local existing=""
  local f
  for f in "${files[@]}"; do
    [[ -f "$f" ]] || continue
    local v
    v="$(read_value "$f" "$key")"
    if [[ -n "$v" ]]; then
      existing="$v"
      break
    fi
  done

  local value generated=0
  if [[ -n "$existing" ]]; then
    value="$existing"
  else
    value="$("$generator")"
    generated=1
  fi

  for f in "${files[@]}"; do
    [[ -f "$f" ]] || continue
    local current
    current="$(read_value "$f" "$key")"
    if [[ -z "$current" ]]; then
      write_value "$f" "$key" "$value"
    fi
  done

  if (( generated == 1 )); then
    echo "$value"
  fi
}

# ---- main ------------------------------------------------------------------

echo "→ aktenraum bootstrap-secrets.sh"
echo "  data dir defaults to ~/aktenraum (Phase 0.2 makes this configurable)"
echo

# 1. Ensure runtime env files exist.
ensure_runtime_file ""           # creates docker/.env from docker/.env.example
ensure_runtime_file "aktenraum-api"
ensure_runtime_file "auto-tagger"
ensure_runtime_file "backup"

ENV_MAIN="${DOCKER_DIR}/.env"
ENV_API="${DOCKER_DIR}/aktenraum-api.env"
ENV_TAGGER="${DOCKER_DIR}/auto-tagger.env"
ENV_BACKUP="${DOCKER_DIR}/backup.env"

# 2. Fill per-file unique secrets.

if fill_if_empty "$ENV_MAIN" PAPERLESS_SECRET_KEY gen_secret_hex; then
  generated_lines+=("Paperless framework secret key: generated ✓")
fi

if fill_if_empty "$ENV_API" JWT_SECRET gen_secret_b64; then
  generated_lines+=("aktenraum-api JWT signing key: generated ✓")
fi

if fill_if_empty "$ENV_BACKUP" RESTIC_PASSWORD gen_password; then
  RESTIC_PW="$(read_value "$ENV_BACKUP" RESTIC_PASSWORD)"
  generated_lines+=("Restic backup passphrase: ${RESTIC_PW}")
  generated_lines+=("  ⚠ Without this passphrase your backups CANNOT be restored. Save it now.")
fi

# 3. User-facing passwords — print in plaintext exactly once if generated.

if fill_if_empty "$ENV_MAIN" PAPERLESS_ADMIN_PASSWORD gen_password; then
  PW="$(read_value "$ENV_MAIN" PAPERLESS_ADMIN_PASSWORD)"
  generated_lines+=("Paperless admin login (http://localhost:8000):")
  generated_lines+=("  username: $(read_value "$ENV_MAIN" PAPERLESS_ADMIN_USER || echo admin)")
  generated_lines+=("  password: ${PW}")
fi

if fill_if_empty "$ENV_API" BOOTSTRAP_PASSWORD gen_password; then
  PW="$(read_value "$ENV_API" BOOTSTRAP_PASSWORD)"
  generated_lines+=("aktenraum SPA login (http://localhost:8080):")
  generated_lines+=("  username: $(read_value "$ENV_API" BOOTSTRAP_USERNAME || echo admin)")
  generated_lines+=("  password: ${PW}")
fi

# 4. Reconcile cross-file shared secrets.

# PAPERLESS_DBPASS lives ONLY in docker/.env and docker/backup.env. compose
# substitutes it into aktenraum-api's DATABASE_URL via `${PAPERLESS_DBPASS}`
# at container-start time, so adding the key to aktenraum-api.env or
# auto-tagger.env would be a misleading duplicate at best and an
# inconsistency footgun at worst (two values that drift apart).
NEW_DBPASS="$(reconcile_shared PAPERLESS_DBPASS gen_password \
  "$ENV_MAIN" "$ENV_BACKUP")"
if [[ -n "$NEW_DBPASS" ]]; then
  generated_lines+=("Postgres password (paperless user): generated ✓")
fi

NEW_WEBHOOK="$(reconcile_shared WEBHOOK_SECRET gen_secret_b64 \
  "$ENV_MAIN" "$ENV_API" "$ENV_TAGGER")"
if [[ -n "$NEW_WEBHOOK" ]]; then
  generated_lines+=("Internal webhook secret (paperless ↔ auto-tagger): generated ✓")
fi

# 5. Final report. Empty array → no-op pass; never print blank credentials.

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
echo "Files updated:"
echo "  ${ENV_MAIN}"
echo "  ${ENV_API}"
echo "  ${ENV_TAGGER}"
echo "  ${ENV_BACKUP}"
echo
echo "Next: cd docker && docker compose up -d"
echo "Then: scripts/bootstrap-paperless.sh   (mints the API token + custom fields)"
