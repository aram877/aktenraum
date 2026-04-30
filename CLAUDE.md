# aktenraum — Claude working guide

Self-hosted personal DMS built on Paperless-ngx with an AI classification layer. Everything runs in Docker. Scripts target bash and run on macOS, Linux, or Windows (Git Bash). Deployment target is Docker Desktop or native Linux Docker.

---

## Stack (7 services — all in `docker/docker-compose.yml`)

| Service | Image | Role | Port |
|---|---|---|---|
| paperless | ghcr.io/paperless-ngx/paperless-ngx | DMS core, OCR, web UI | `127.0.0.1:8000` |
| postgres | postgres:15 | Paperless database | internal |
| redis | redis:7 | Paperless task queue | internal |
| gotenberg | gotenberg/gotenberg:8 | PDF conversion | internal |
| tika | apache/tika | Document parsing | internal |
| auto-tagger | local build | AI classification service | internal |
| backup | local build | Daily restic backup via crond | internal |

> **Note**: use `apache/tika` — NOT `ghcr.io/paperless-ngx/tika` (requires auth, returns 403).

### Start / stop

```bash
cd docker
docker compose up -d          # start all
docker compose down           # stop all (data preserved)
docker compose up -d --build auto-tagger   # rebuild after code changes
docker compose up -d --build backup        # rebuild after backup changes
```

### Logs

```bash
docker compose logs -f auto-tagger
docker compose logs -f backup
docker compose logs --tail=50 paperless
```

---

## Credentials & secrets

| What | Value | Where |
|---|---|---|
| Paperless URL | http://localhost:8000 | — |
| Paperless admin | admin / test1234 | `docker/.env` |
| Paperless DB password | 5076f52c96c46b7c79c203ee9170f898 | `docker/.env` |
| Paperless API token | 4a19e91ea9edd476f6b4684a0d6579eaec66df41 | `docker/auto-tagger.env` |
| Restic passphrase | bfW6+AK3l/nRB13xGcl2YTmo2eI+fgQv | `docker/backup.env` |
| Ollama model | gemma4:e4b (or gemma4:26b) | `docker/auto-tagger.env` |

Env files are gitignored. Examples: `docker/.env.example`, `docker/auto-tagger.env.example`, `docker/backup.env.example`.

---

## Paperless API quick reference

```bash
TOKEN="4a19e91ea9edd476f6b4684a0d6579eaec66df41"
BASE="http://localhost:8000"

# Document counts by tag
curl -s -H "Authorization: Token $TOKEN" "$BASE/api/documents/?page_size=1" | python -c "import sys,json; print(json.load(sys.stdin)['count'])"

# All tags
curl -s -H "Authorization: Token $TOKEN" "$BASE/api/tags/?page_size=100" | python -c "import sys,json; [print(t['id'], t['name'], t.get('document_count')) for t in json.load(sys.stdin)['results']]"

# Clear tags from a document (triggers retag)
curl -s -X PATCH "$BASE/api/documents/{id}/" -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" -d '{"tags": []}'

# Get API token via credentials
curl -s -X POST "$BASE/api/token/" -H "Content-Type: application/json" -d '{"username":"admin","password":"test1234"}' | python -c "import sys,json; print(json.load(sys.stdin)['token'])"
```

> **Gotcha**: Paperless `?name=` filter does **substring matching**, not exact match. Always filter results in Python: `next((t["id"] for t in results if t["name"] == name), None)`.

---

## Directory layout

```
/
├── docker/
│   ├── docker-compose.yml       # full stack definition
│   ├── .env                     # gitignored — Paperless secrets
│   ├── .env.example             # committed template
│   ├── auto-tagger.env          # gitignored — LLM config + API token
│   ├── auto-tagger.env.example
│   ├── backup.env               # gitignored — RESTIC_PASSWORD + DB creds
│   ├── backup.env.example
│   ├── backup/                  # backup service: Dockerfile, entrypoint.sh, crontab
│   └── systemd/                 # systemd units for future Linux-native deploy
├── services/
│   └── auto-tagger/             # Python 3.13, uv, src/auto_tagger/
│       ├── src/auto_tagger/
│       │   ├── config.py        # Pydantic BaseSettings (all env vars)
│       │   ├── models.py        # DocumentExtraction + DocumentType enum (20 values)
│       │   ├── paperless.py     # async httpx Paperless API client
│       │   ├── tagger.py        # German prompt + extraction flow
│       │   ├── main.py          # async polling loop
│       │   └── llm/             # AnthropicBackend, OllamaBackend, factory
│       └── Dockerfile           # python:3.13-slim + uv, non-root user
├── apps/
│   └── web/                     # placeholder only — Next.js frontend (not built)
├── docs/
│   ├── adr/                     # Architecture Decision Records
│   └── runbooks/                # first-time-setup, operations, restore, rotate-keys
├── scripts/
│   ├── setup.sh                 # create ~/aktenraum/ dirs
│   ├── bootstrap-paperless.sh   # create AI custom fields + tags via API
│   └── backup.sh                # host-side manual backup (mirrors container logic)
└── openspec/
    └── changes/                 # aktenraum-foundation, backup-timer (completed)
```

---

## Auto-tagger behaviour

The service runs two parallel async polling loops in the same container:

**Extraction loop** (always on):
- Polls `GET /api/documents/` every 30s, skips docs carrying any of the six AI lifecycle tags (`ai-pending`, `ai-approved`, `ai-rejected`, `ai-propagated`, `ai-propagation-error`, `ai-error`)
- Sends OCR text (truncated to 8000 tokens) to Ollama or Anthropic
- Writes 12 custom fields to the document + adds `ai-pending` tag (entry state of the lifecycle)

**Propagation loop** (when `ENABLE_PROPAGATION=true`, default):
- Polls every 30s for documents tagged `ai-approved`
- Reads `ai_correspondent`, `ai_document_type`, `ai_issue_date`, `ai_suggested_tags` and writes them to **native** Paperless fields (creating Correspondent / DocumentType / Tag entities by exact-name match if missing)
- Single PATCH per doc: sets correspondent + document_type + created_date + tags
- On success: swaps `ai-approved` for `ai-propagated`
- On failure: swaps `ai-approved` for `ai-propagation-error` (so the doc does not loop)

**User actions in the UI:**
- **Retag a document**: remove all `ai-*` lifecycle tags → extraction loop picks it up on next poll
- **Approve**: replace `ai-pending` with `ai-approved` → propagation loop fires within 30s
- **Reject**: replace `ai-pending` with `ai-rejected` → no propagation, no further processing

### LLM backends

| Env | Backend |
|---|---|
| `LLM_BACKEND=ollama` | Ollama at `http://host.docker.internal:11434` |
| `LLM_BACKEND=anthropic` | Anthropic API (`claude-sonnet-4-6`) |

Switch by editing `docker/auto-tagger.env` and running `docker compose up -d auto-tagger` (restart alone does NOT re-read env files — must use `up -d`).

### Document taxonomy (20 types)

Rechnung · Gehaltsabrechnung · Kontoauszug · Nebenkostenabrechnung · Mahnung · Vertrag · Kündigung · Versicherung · Steuer · Bescheid · Behördenbrief · Kfz · Arztbrief · Garantie · Urkunde · Ausweis · Zeugnis · Arbeitszeugnis · Mitgliedschaft · Sonstiges

Defined in `services/auto-tagger/src/auto_tagger/models.py` `DocumentType` enum. Prompt definitions in `tagger.py` `SYSTEM_PROMPT`.

---

## Backup

- **Container**: `backup` service, crond fires `entrypoint.sh` daily at 02:00
- **What**: `~/aktenraum/data`, `media`, `export` + live postgres dump (stdin pipe, no temp file)
- **Retention**: 7 daily, 4 weekly, 12 monthly
- **Repo**: `~/aktenraum/backup/restic-repo/` (mounted at `/repo` in container)
- **Manual run**: `MSYS_NO_PATHCONV=1 docker compose exec backup //usr/local/bin/entrypoint.sh`
- **List snapshots**: `MSYS_NO_PATHCONV=1 docker compose exec backup restic snapshots --tag aktenraum`

---

## Development workflow (OpenSpec)

All non-trivial changes go through OpenSpec before implementation:

```bash
openspec new change "<name>"          # scaffold proposal/design/specs/tasks
openspec status --change "<name>"     # check artifact progress
openspec instructions <id> --change "<name>"  # get writing instructions per artifact
```

Artifacts: `proposal.md` → `design.md` + `specs/` → `tasks.md` → implement.
Completed changes: `aktenraum-foundation`, `backup-timer`.

Use `/openspec-propose` skill to create a full change in one step.
Use `/opsx:apply` skill to implement tasks from an approved change.

---

## Known gotchas

| Issue | Fix |
|---|---|
| `docker compose restart` doesn't re-read env files | Use `docker compose up -d` to recreate the container |
| Git Bash converts `/usr/local/bin/...` to Windows path in `docker exec` | Prefix with `MSYS_NO_PATHCONV=1` and use `//usr/local/bin/...` |
| Paperless `?name=` filter does substring match | Filter by exact name in Python after API call (done in `paperless.py`) |
| `ghcr.io/paperless-ngx/tika` requires auth | Use `apache/tika` instead |
| `python` vs `python3` differs across platforms (Git Bash has `python`, macOS has `python3`) | Scripts auto-detect with `command -v python3 \|\| command -v python` |
| Ollama model may return `---\n{...}` (YAML prefix) or integers in tag lists | Handled in `ollama_backend.py` `_clean_json()` and `models.py` `CoercedStr` |

---

## What's implemented vs planned

| Feature | Status |
|---|---|
| Paperless-ngx deployment | ✅ Running |
| Auto-tagger (Ollama + Anthropic) | ✅ Running |
| 20-type German document taxonomy | ✅ Live |
| Daily backup (Docker crond + restic) | ✅ Running |
| Retag from web UI (FastAPI + htmx) | 🔲 Planned |
| Custom React/Next.js frontend | 🔲 Planned (apps/web placeholder) |
| Semantic search / RAG | 🔲 Planned |
| HTTPS / Tailscale | 🔲 Planned (TODO in runbook) |
