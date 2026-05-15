# Development guide

Everything you need to start the stack, develop against it, and ship a
change. For why the stack looks the way it does see
[architecture.md](architecture.md); for every env-var knob see
[configuration.md](configuration.md).

---

## Prerequisites

- Docker Desktop or Docker Engine + Compose v2.
- `bash` (macOS, Linux, or Windows Git Bash).
- For host-side Python work: nothing — `uv` is invoked through the workspace.
- For host-side SPA work: Node 20+ and `pnpm` (`corepack enable && corepack prepare pnpm@latest --activate`).
- For backups: `restic` only if you run the host-side `scripts/backup.sh`. The Dockerised `backup` service ships its own restic.
- For Ollama (default LLM backend): install Ollama on the host and `ollama pull gemma4:latest`. The auto-tagger reaches it via `http://host.docker.internal:11434`.

You do NOT need a Python or Node toolchain installed to run the stack —
both services build inside Docker. The host installs are only for editing
code with hot-reload.

---

## First-time setup

```bash
git clone <this-repo>
cd aktenraum
bash scripts/setup.sh                # create ~/aktenraum/{consume,media,data,export,pgdata,backup/restic-repo}
bash scripts/bootstrap-secrets.sh    # generate all REQUIRED secrets into docker/*.env
cd docker && docker compose up -d
```

`bootstrap-secrets.sh` is idempotent. It copies `docker/*.env.example` →
`docker/*.env` if absent, fills any empty `REQUIRED` value with
`openssl rand`, and reconciles cross-file shared secrets (`PAPERLESS_DBPASS`,
`WEBHOOK_SECRET`). It prints the generated admin/SPA passwords **once**;
save them.

After the stack is up:

```bash
# Wait until paperless is ready
docker compose logs -f paperless     # look for "Ready"

# Mint a Paperless API token (one-time; uses the admin password from bootstrap)
TOKEN=$(curl -s -X POST "http://localhost:8000/api/token/" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"<from-bootstrap>\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# Put it in BOTH env files (auto-tagger uses it for writes; aktenraum-api uses it for the SPA's AI features)
echo "PAPERLESS_API_TOKEN=$TOKEN" >> docker/auto-tagger.env
echo "PAPERLESS_API_TOKEN=$TOKEN" >> docker/aktenraum-api.env

# Re-create the containers so the new env is picked up (restart alone does NOT re-read env files)
cd docker && docker compose up -d auto-tagger aktenraum-api

# Bootstrap Paperless: create custom fields + lifecycle tags
PAPERLESS_BASE_URL=http://localhost:8000 \
PAPERLESS_API_TOKEN=$TOKEN \
bash ../scripts/bootstrap-paperless.sh
```

The SPA is at <http://localhost:8080>. Log in with `BOOTSTRAP_USERNAME` /
`BOOTSTRAP_PASSWORD` from `docker/aktenraum-api.env`.

A more detailed walkthrough lives at
[runbooks/first-time-setup.md](runbooks/first-time-setup.md).

---

## Daily start / stop

```bash
cd docker
docker compose up -d                 # start everything
docker compose down                  # stop everything (data preserved)
docker compose ps                    # status overview
```

A typical dev session:

```bash
# Backend services run in compose; SPA runs with hot-reload on the host
cd docker && docker compose up -d
cd ../apps/web && pnpm install
pnpm --filter @aktenraum/web dev     # vite on :5173, proxies /api → :8080
```

Open <http://localhost:5173> for hot-reloaded SPA against the running
compose stack. The production SPA at `:8080` is unaffected.

---

## Rebuilding after code changes

`docker compose restart` does **not** re-read env files or pick up
Python/source changes. Use `up -d --build`:

| You changed | Rebuild |
|---|---|
| `services/auto-tagger/**` or `packages/aktenraum-core/**` | `docker compose up -d --build auto-tagger` |
| `services/aktenraum-api/**` or `packages/aktenraum-core/**` | `docker compose up -d --build aktenraum-api` |
| `apps/web/**` (production build) | `docker compose up -d --build nginx` |
| `docker/nginx/nginx.conf` | `docker compose up -d --build nginx` |
| Any `docker/*.env` value | `docker compose up -d <service>` (re-create, no rebuild) |
| `docker/docker-compose.yml` | `docker compose up -d` |

The auto-tagger Dockerfile's build context is the repo root, so a
single rebuild picks up both `services/auto-tagger/src/` and
`packages/aktenraum-core/src/` edits. Same for `aktenraum-api`.

---

## Running tests

### Python (workspace root)

```bash
uv sync                              # install deps for both workspace members
uv run pytest                        # full suite (~50s, 420+ tests)
uv run pytest services/auto-tagger   # auto-tagger only
uv run pytest -k webhook             # tests matching "webhook"
uv run ruff check                    # lint both members
uv run ruff format                   # auto-format
```

The pytest suite is pure-function — no live HTTP, no docker dependency.
You can run it without the stack up.

### SPA

```bash
pnpm --filter @aktenraum/web lint    # eslint
pnpm --filter @aktenraum/web build   # tsc + vite production build
pnpm --filter @aktenraum/web generate:api-types
                                     # regenerate TS types from /api/openapi.json
                                     # (compose stack must be running)
```

There is no Vitest/Jest suite for the SPA yet — `tsc -b && vite build`
covers types and compile-time correctness.

### CI

GitHub Actions runs two jobs on every push and PR
(`.github/workflows/ci.yml`):
- **python** — `uv sync && uv run ruff check && uv run pytest`
- **web** — `pnpm install --frozen-lockfile && pnpm lint && pnpm build`

---

## Logs and debugging

```bash
# Service logs
docker compose logs -f auto-tagger
docker compose logs -f aktenraum-api
docker compose logs --tail=50 paperless

# What's a doc's current state?
TOKEN=$(grep PAPERLESS_API_TOKEN docker/auto-tagger.env | cut -d= -f2)
curl -s -H "Authorization: Token $TOKEN" \
  "http://localhost:8000/api/documents/<ID>/" | python3 -m json.tool

# Trigger extraction on a specific doc (bypasses the 30s poll lag)
docker compose exec paperless curl -sS -H "Content-Type: application/json" \
  -d '{"document_id": <ID>}' http://auto-tagger:8001/trigger/extract

# Clear lifecycle tags → poller re-extracts within 30s
curl -s -X PATCH "http://localhost:8000/api/documents/<ID>/" \
  -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
  -d '{"tags": []}'
```

The user's global `~/.claude/CLAUDE.md` says: **when debugging, always
use logs**. The auto-tagger uses `structlog` with key=value output; grep
for these events:

| Event | Meaning |
|---|---|
| `auto_tagger_starting` | Service start |
| `extraction_successful` doc_id=N | LLM call returned a valid extraction |
| `extraction_failed` | LLM/transport/validation error; doc gets `ai-error` |
| `ai_title_synthesized` | LLM dropped `ai_title`; Python fallback filled it in |
| `routing_decision` tags=[…] | Confidence-based tag(s) applied |
| `paperless_patch_rejected` body=… | Paperless 4xx with the response body verbatim |
| `skip_already_processed` | Webhook + poller race; this fire is the duplicate |
| `indexer_doc_indexed` | RAG chunks upserted into Qdrant |

---

## Common tasks

### Inspect Paperless via API

```bash
TOKEN=$(grep PAPERLESS_API_TOKEN docker/auto-tagger.env | cut -d= -f2)
BASE=http://localhost:8000

# All tags (?name= is silently ignored — use ?name__iexact=)
curl -s -H "Authorization: Token $TOKEN" "$BASE/api/tags/?page_size=200" | python3 -m json.tool

# All custom fields with their ids
curl -s -H "Authorization: Token $TOKEN" "$BASE/api/custom_fields/?page_size=100" | python3 -m json.tool

# Search documents (use document_type__id NOT document_type=)
curl -s -H "Authorization: Token $TOKEN" "$BASE/api/documents/?document_type__id=5&ordering=-created" | python3 -m json.tool
```

### Reprocess every document (re-run the AI on the full corpus)

`/api/documents/{id}/reprocess` on each doc, or clear lifecycle tags in
Paperless and let the poller catch up:

```bash
TOKEN=$(grep PAPERLESS_API_TOKEN docker/auto-tagger.env | cut -d= -f2)
for id in $(curl -s -H "Authorization: Token $TOKEN" \
              "http://localhost:8000/api/documents/?page_size=200" \
            | python3 -c "import sys,json; print(*[d['id'] for d in json.load(sys.stdin)['results']])"); do
  curl -s -X PATCH "http://localhost:8000/api/documents/$id/" \
    -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
    -d '{"tags": []}'
done
```

Useful after a prompt change. Cost: one LLM call per doc.

### Switch LLM backend

Edit `docker/auto-tagger.env` AND `docker/aktenraum-api.env`:

```bash
LLM_BACKEND=ollama        # or anthropic
OLLAMA_MODEL=gemma4:latest
# or
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6
```

Then `docker compose up -d auto-tagger aktenraum-api` to recreate the
containers (env-file changes need a recreate, not a restart).

You can pair models: a fast 8B for filter extraction + a smarter 14B+
for prose answers. Set `OLLAMA_ANSWER_MODEL` / `ANTHROPIC_ANSWER_MODEL` to
override the model used by `/api/ai/answer/stream` only.

### Backfill the RAG index

After enabling Qdrant (or upgrading to a new chunker/embedder), the
existing corpus needs a one-shot index pass — newly-propagated docs
index automatically but old ones don't:

```bash
bash scripts/backfill-rag-index.sh           # idempotent, skips already-indexed
bash scripts/backfill-rag-index.sh --force   # re-index everything
```

JSON-line events on stdout (`started → doc_indexed* → completed`).
Resumable: re-running on a fully-indexed corpus is a fast no-op.

### Run the RAG eval harness

Cases live in `evals/golden-questions.yaml` (bind-mounted into the api
container at `/app/evals/`).

```bash
bash scripts/run-rag-eval.sh              # text report
bash scripts/run-rag-eval.sh --json       # CI-friendly JSON
```

Output: per-case rank + hit/miss + aggregate `recall@K` and `MRR`. Exit
code stays 0 regardless of metrics — the CI wrapper sets the threshold.

The committed YAML is keyed to the maintainer's local Paperless ids;
new collaborators copy it to a private location and re-pin against
their own corpus.

### Run a manual backup

```bash
# Dockerised path (default)
MSYS_NO_PATHCONV=1 docker compose exec backup //usr/local/bin/entrypoint.sh
MSYS_NO_PATHCONV=1 docker compose exec backup restic snapshots --tag aktenraum

# Host-side path (only if you opted into the systemd unit)
export RESTIC_PASSWORD=...
export PAPERLESS_DBUSER=paperless PAPERLESS_DBPASS=...
bash scripts/backup.sh
```

Restore is documented in [runbooks/restore.md](runbooks/restore.md).

### Rotate the JWT secret / API keys

[runbooks/rotate-api-keys.md](runbooks/rotate-api-keys.md) covers
Paperless API token, JWT signing secret, and webhook secret rotation —
the safe order is critical (auto-tagger and aktenraum-api must share
the Paperless token and the webhook secret).

---

## OpenSpec workflow

All non-trivial changes go through OpenSpec before code:

```bash
openspec new change "<name>"            # scaffold proposal/design/specs/tasks
openspec status --change "<name>"       # what's left
openspec instructions <id> --change "<name>"   # writing guide per artifact
```

Artifacts under `openspec/changes/<name>/`:
- `proposal.md` — what + why
- `design.md` + `specs/` — how
- `tasks.md` — execution checklist

Completed changes are archived under `openspec/changes/_archived/`.
The `/openspec-propose` and `/opsx:apply` Skills automate the scaffolding.

---

## Commit policy

From the repo's `CLAUDE.md`:

> - NEVER EVER commit anything before running tests locally.
> - NEVER EVER commit after fixing a bug without me first confirming that the bug is fixed.

Tests in this repo means `uv run pytest` AND (when SPA touched)
`pnpm --filter @aktenraum/web build`. CI runs both anyway, but local
tests catch the obvious before the round-trip.

Conventional commit prefixes used in this repo: `feat`, `fix`, `refactor`,
`docs`, `test`, `chore`. Scopes seen in the log: `auto-tagger`, `spa`,
`api`, `compose`, `rag`. `git log --oneline -20` is the style guide.

---

## Documentation cadence

From `CLAUDE.md`: every working session ends with a daily summary at
`docs/sessions/YYYY-MM-DD.md` (what shipped, by feature, with commit
hashes + a "pick up next session" block + active roadmap progress).

- Architectural decisions → `docs/adr/NNN-name.md`
  (template at [`docs/adr/000-template.md`](adr/000-template.md))
- Multi-phase initiatives → `docs/plans/<topic>.md`
- When you change a feature, gotcha, or constraint, update `CLAUDE.md`
  in the same commit so future sessions see current state without
  trawling git log.

---

## Known gotchas

Things that have cost a debugging session at least once. Most are also in `CLAUDE.md`.

| Symptom | Cause | Fix |
|---|---|---|
| `docker compose restart` doesn't pick up an env-file change | restart re-uses the container's existing env | `docker compose up -d <service>` to recreate |
| Python source change has no effect after restart | Image is cached | `docker compose up -d --build <service>` |
| `?name=foo` on `/api/tags/` returns the first page regardless | Paperless silently ignores it | Use `?name__iexact=foo` |
| Custom-field PATCH 400s on a long value | `data_type=string` has a 128-char hard limit | `truncate_for_field` at the boundary; use `longtext` for fields that need more |
| Custom-field `data_type=monetary` rejects German `149,99 EUR` | Wants `<ISO><amount>` (`EUR149.99`) | `_normalize_monetary` |
| Custom-field `data_type=date` rejects `01.12.2024` | Wants strict `YYYY-MM-DD` | `_normalize_date` |
| OCR fragments numbers ("28.02.24" → "2 8. 0 2.24") | Paperless OCR artefact | `SYSTEM_PROMPT` tells the LLM to recognise the pattern — keep the rule when editing |
| Paperless picks a birthdate as `created_date` | The consumer's content-OCR date detector can't be disabled | Rely on `ai_issue_date` being correct so propagation overrides; or set `PAPERLESS_IGNORE_DATES` |
| `data_type` can't be changed after a custom field is created | Paperless limitation | Plan field types up front; recreate to migrate |
| `python` vs `python3` differs across platforms | Git Bash has `python`, macOS has `python3` | Scripts auto-detect: `command -v python3 \|\| command -v python` |
| Ollama returns `---\n{...}` (YAML prefix) or `null` for empty list fields | Small model artefact | Handled by `ollama_backend._clean_json` + Pydantic `CoercedStr` / `CoercedList` |
| `pydantic-settings` JSON-parses `list[str]` env values — comma-CSV fails | Default decode | Use `Annotated[list[str], NoDecode]` + `field_validator(mode="before")` |
| Webhook + poller race-enqueue the same doc | Both are intentional safety nets | Worker re-checks lifecycle on dequeue; logs `skip_already_processed` |
| Same content uploaded twice silently dropped | Paperless dedups by SHA1 | Working as intended; SPA shows "Paperless verarbeitet" → "✓ in der Inbox" only once |
| `apache/tika` vs `ghcr.io/paperless-ngx/tika` | The ghcr one requires auth | Stay on `apache/tika` |
| Port 80 already taken | Another local stack (traefik etc.) | Override `AKTENRAUM_WEB_PORT` in `docker/.env` |
| Restic `--last` flag is deprecated | Restic CLI change | Use `--latest <N>` |
