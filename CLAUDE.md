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

| What | Where |
|---|---|
| Paperless URL | http://localhost:8000 |
| Paperless admin | `PAPERLESS_ADMIN_USER` / `PAPERLESS_ADMIN_PASSWORD` in `docker/.env` |
| Paperless DB password | `PAPERLESS_DBPASS` in `docker/.env` |
| Paperless API token | `PAPERLESS_API_TOKEN` in `docker/auto-tagger.env` (mint via `POST /api/token/` after first paperless boot — example below) |
| Restic passphrase | `RESTIC_PASSWORD` in `docker/backup.env` |
| Webhook secret | `WEBHOOK_SECRET` in `docker/.env` (passed to paperless's post_consume hook) AND `docker/auto-tagger.env` (must match) |
| LLM backend | `LLM_BACKEND=ollama` or `anthropic` in `docker/auto-tagger.env` |
| Ollama model | `OLLAMA_MODEL=gemma4:latest` (what we run); larger models or `qwen` family work too |

Env files are gitignored. Examples: `docker/.env.example`, `docker/auto-tagger.env.example`, `docker/backup.env.example`. The API token in `auto-tagger.env` is **per-database** — a fresh `pgdata/` means re-minting.

---

## Paperless API quick reference

```bash
TOKEN="$(grep PAPERLESS_API_TOKEN docker/auto-tagger.env | cut -d= -f2)"
BASE="http://localhost:8000"

# Mint a fresh token (use after starting paperless on an empty DB)
curl -s -X POST "$BASE/api/token/" -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"test1234"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])"

# All tags
curl -s -H "Authorization: Token $TOKEN" "$BASE/api/tags/?page_size=200" | python3 -c "import sys,json; [print(t['id'], t['name']) for t in json.load(sys.stdin)['results']]"

# Look up a specific tag by name (use ?name__iexact=, NOT ?name=)
curl -s -H "Authorization: Token $TOKEN" "$BASE/api/tags/?name__iexact=ai-pending"

# Clear tags from a document (sends it back to the extraction queue)
curl -s -X PATCH "$BASE/api/documents/{id}/" -H "Authorization: Token $TOKEN" \
  -H "Content-Type: application/json" -d '{"tags": []}'

# Trigger extraction directly via the auto-tagger webhook (bypasses the 30s poll lag)
docker compose exec paperless curl -sS -H "Content-Type: application/json" \
  -d '{"document_id": 12}' http://auto-tagger:8001/trigger/extract
```

### Paperless API gotchas (each cost a debug session)

- **`?name=` is silently ignored on `/api/tags/`** — it returns the default first page regardless. Use `?name__iexact=<name>` for exact match. The Python-side equality check stays as defence in depth (see `paperless._get_or_create_named`).
- **Custom fields with `data_type=string` have a hard 128-char DB limit.** Anything longer 400s the entire PATCH. We truncate at the boundary with `_truncate_string_field` (ellipsis at 128 chars).
- **Custom fields with `data_type=monetary` require the format `<ISO_CODE><amount>`** (e.g., `EUR149.99`) — the German format `149,99 EUR` is rejected. We normalise via `_normalize_monetary` (handles symbols, German/Anglophone thousands separators).
- **Custom fields with `data_type=date` require strict YYYY-MM-DD.** German `DD.MM.YYYY`, slashes, month-year-only all rejected. We normalise via `_normalize_date`.
- **Paperless's content-OCR date detector cannot be disabled.** It runs in the consumer (`documents/consumer.py:430`) when the parser ships no PDF metadata date and grabs *any* date from the OCR text. It commonly picks up birthdates from CVs / IDs. Workaround: rely on the AI's `ai_issue_date` being correct so propagation overrides it; for a known recurring bad date use `PAPERLESS_IGNORE_DATES` env var.
- **Custom fields data type cannot be changed after creation.** Plan field types up front; recreate to migrate.
- **OCR fragments numbers with spaces** ("28.02.24" → "2 8. 0 2.24"). The system prompt explicitly tells the LLM to recognise this; keep that rule when editing.

---

## Directory layout

```
/
├── .github/
│   └── workflows/ci.yml         # uv setup → ruff check → pytest
├── docker/
│   ├── docker-compose.yml       # full stack definition
│   ├── .env                     # gitignored — Paperless secrets
│   ├── .env.example             # committed template
│   ├── auto-tagger.env          # gitignored — LLM config + API token
│   ├── auto-tagger.env.example
│   ├── backup.env               # gitignored — RESTIC_PASSWORD + DB creds
│   ├── backup.env.example
│   ├── backup/                  # backup service: Dockerfile, entrypoint.sh, crontab
│   ├── paperless-scripts/       # post_consume.sh — paperless → auto-tagger webhook trigger
│   └── systemd/                 # systemd units for future Linux-native deploy
├── services/
│   └── auto-tagger/             # Python 3.13, uv, src/auto_tagger/
│       ├── src/auto_tagger/
│       │   ├── config.py        # Pydantic BaseSettings (all env vars)
│       │   ├── models.py        # DocumentExtraction + DocumentType enum (20 values)
│       │   ├── paperless.py     # async httpx Paperless API client + LIFECYCLE_TAGS
│       │   ├── tagger.py        # German prompt + routing + few-shot + history hint
│       │   ├── propagator.py    # ai-approved → native fields + ai-propagated
│       │   ├── webhook.py       # aiohttp listener for paperless's post_consume hook
│       │   ├── main.py          # asyncio.gather of extraction worker, poller, propagation, http server
│       │   └── llm/             # AnthropicBackend, OllamaBackend, factory
│       ├── tests/               # pytest suite (97+ tests) — pure-function, no live HTTP
│       │   ├── conftest.py      # `make_settings` fixture used across files
│       │   ├── test_models.py   # DocumentExtraction validation
│       │   ├── test_paperless.py# normalisers + truncator + LIFECYCLE_TAGS
│       │   ├── test_propagator.py# suggested-tags filter
│       │   ├── test_tagger.py   # routing matrix + history hint + few-shot rendering
│       │   └── test_webhook.py  # aiohttp handler (auth, queue, /health)
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

The service runs four concurrent async tasks via `asyncio.gather` in `main.py`, sharing one `asyncio.Queue[int]` for extraction work:

```
                        Paperless's post_consume_script
                                      ↓
                          POST /trigger/extract
                                      ↓
   poller ─────────► asyncio.Queue[int] ◄───── webhook handler
   (every 30s,                |
   safety net)                ▼
                       extraction worker
                       (drains queue,
                       per-doc fault boundary)
                                      ↓
                          process_document → tag

   propagation loop (every 30s, polls for ai-approved → native fields)
```

### Lifecycle tags (7 total — 6 lifecycle + 1 auxiliary)

| Tag | Meaning |
|---|---|
| `ai-pending` | Extracted, awaiting human review |
| `ai-approved` | User approved → propagation watcher will copy to native fields |
| `ai-rejected` | User rejected → no propagation, no retry |
| `ai-propagated` | Native correspondent/document_type/tags written; final success state |
| `ai-propagation-error` | Propagation failed mid-run; manual intervention needed |
| `ai-error` | Extraction failed (LLM error, schema validation, etc.); manual retry by clearing tags |
| `ai-low-confidence` | Auxiliary flag (not a lifecycle state); coexists with `ai-pending` to surface uncertain extractions in the review queue |

The auto-tagger's poller excludes the six lifecycle tags from its scan; the worker re-checks on dequeue and skips with `skip_already_processed` if any lifecycle tag is set (handles webhook+poller race).

### Extraction (worker + poller + webhook)

- **Webhook** (`POST /trigger/extract`, port 8001 internal-only): paperless's `post_consume_script` POSTs the doc id; auto-tagger enqueues. Optional `X-Aktenraum-Secret` header — when `WEBHOOK_SECRET` is set, must match.
- **Poller** (`POLL_INTERVAL_SECONDS`, default 30s): scans for docs without lifecycle tags and enqueues. Safety net for missed webhooks.
- **Worker**: drains queue. Per-doc steps:
  1. Re-fetch by id; skip if any lifecycle tag (race protection)
  2. Build prompt: base SYSTEM_PROMPT + (optional) per-correspondent history hint + (optional) few-shot exemplars from propagated corpus
  3. Call configured LLM backend; validate via Pydantic
  4. PATCH 12 `ai_*` custom fields (with monetary, date, string normalisers at boundary)
  5. Apply lifecycle tag(s) per routing rules (single PATCH)

### Confidence-based routing (`tagger._route_lifecycle_tags`)

| Condition | Tag(s) applied |
|---|---|
| `confidence ≥ AUTO_APPROVE_CONFIDENCE` AND `document_type ∈ AUTO_APPROVE_TYPES` | `ai-approved` (skips review; propagation fires) |
| Otherwise | `ai-pending` |
| Additionally if `confidence < LOW_CONFIDENCE_THRESHOLD` (and not auto-approving) | adds `ai-low-confidence` |

`AUTO_APPROVE_TYPES` is comma-separated (`Rechnung,Kontoauszug`); empty disables auto-approve. `pydantic-settings` needs `Annotated[list[str], NoDecode]` for this to work — see `config.py`.

### Corpus-driven learning (no model retraining)

- **Few-shot exemplars** (`FEW_SHOT_EXAMPLES`, default 0): each extraction prepends N most-recently-propagated docs as `(text excerpt, expected JSON)` pairs in the system prompt. Reads native fields (post-propagation ground truth) with fallback to `ai_*` custom fields.
- **Per-correspondent history hint** (`USE_CORRESPONDENT_HISTORY`, default true): builds `{sender: {document_type: count}}` from the `ai-propagated` corpus. If the document text mentions a known sender (longest substring match in first 1000 chars), prepends a German hint naming the dominant past type (≥70% of ≥2 prior docs) or the full distribution.

Together these turn user corrections into future signal: edit the AI fields pre-approval, OR rename a Correspondent post-propagation, and the next extraction sees the corrected version.

### Propagation (`propagator.process_approved_document`)

- Polls every 30s for `ai-approved`
- Reads `ai_correspondent` / `ai_document_type` / `ai_issue_date` / `ai_suggested_tags`
- Looks up or creates Paperless native entities (Correspondent, DocumentType, Tag) by exact-name match (`?name__iexact=`)
- Single PATCH: sets `correspondent`, `document_type`, `created_date`, `tags` (existing tags + propagated state + suggested tags merged; `ai-approved` removed)
- On success: tags `ai-propagated`. On any failure: tags `ai-propagation-error` (no retry loop).

### User actions in the UI

- **Retag a doc**: remove all `ai-*` lifecycle tags → poller/webhook re-extracts
- **Approve**: replace `ai-pending` with `ai-approved` → propagation within 30s
- **Reject**: replace `ai-pending` with `ai-rejected` → no propagation, doc untouched

### LLM backends

| Env | Backend |
|---|---|
| `LLM_BACKEND=ollama` | Ollama at `http://host.docker.internal:11434` |
| `LLM_BACKEND=anthropic` | Anthropic API (`claude-sonnet-4-6`) |

Switch by editing `docker/auto-tagger.env` and running `docker compose up -d auto-tagger` (restart alone does NOT re-read env files — must use `up -d`). After Python source changes also use `--build`.

### Document taxonomy (20 types)

Rechnung · Gehaltsabrechnung · Kontoauszug · Nebenkostenabrechnung · Mahnung · Vertrag · Kündigung · Versicherung · Steuer · Bescheid · Behördenbrief · Kfz · Arztbrief · Garantie · Urkunde · Ausweis · Zeugnis · Arbeitszeugnis · Mitgliedschaft · Sonstiges

Defined in `services/auto-tagger/src/auto_tagger/models.py` `DocumentType` enum. Prompt definitions in `tagger.py` `SYSTEM_PROMPT` (which also has explicit per-field disambiguation rules — read before editing).

---

## Validation patterns at the LLM/Paperless boundary

Local LLMs (especially small ones like gemma4 8B) emit data the Paperless API rejects on edge cases. We layer two defences: schema-level coercion at the Pydantic boundary, and value normalisation at the PATCH boundary.

| Issue | Where | Fix |
|---|---|---|
| LLM returns `null` for a list field instead of `[]` | `models.CoercedList` (BeforeValidator) | Coerces None → [] |
| LLM returns int in a list of strings (e.g. `[42, "text"]`) | `models.CoercedStr` (BeforeValidator) | Coerces to str |
| LLM emits monetary as German `"149,99 EUR"`; Paperless wants `"EUR149.99"` | `paperless._normalize_monetary` | Regex parse + ISO-format reformat |
| LLM emits date as `"01.12.2024"` or `"12-2024"`; Paperless wants `"YYYY-MM-DD"` | `paperless._normalize_date` | strptime against a list of common formats |
| LLM emits a string longer than Paperless's 128-char custom-field limit | `paperless._truncate_string_field` | Truncate with `…` ellipsis |
| LLM suggests a lifecycle tag (`ai-approved`) as a real tag | `propagator._split_suggested_tags` | Filter out lifecycle names |
| LLM suggests a tag truncated by the 128-char limit (ends with `…`) | `propagator._split_suggested_tags` | Drop fragments ending in ellipsis |
| Paperless 4xx hides the validation reason | `paperless.patch_document_native_fields` + `_get_or_create_named` | Log response body via `paperless_patch_rejected` / `paperless_create_rejected` events |

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
| Python source changes don't take effect on restart | `docker compose up -d --build auto-tagger` to rebuild |
| Git Bash converts `/usr/local/bin/...` to Windows path in `docker exec` | Prefix with `MSYS_NO_PATHCONV=1` and use `//usr/local/bin/...` |
| Paperless `?name=` filter is silently ignored on `/api/tags/` (returns first page regardless) | Use `?name__iexact=<name>`; keep the Python equality re-check as defence in depth |
| Paperless `data_type=string` custom fields have a hard 128-char limit | Use `_truncate_string_field` at the boundary; ellipsis on overflow |
| Paperless `data_type=monetary` requires `<ISO><amount>` format | Use `_normalize_monetary` |
| Paperless `data_type=date` requires strict YYYY-MM-DD | Use `_normalize_date` |
| Paperless's content-OCR date detector cannot be turned off via env var | Rely on AI extracting `ai_issue_date` correctly so propagation overrides; or use `PAPERLESS_IGNORE_DATES` for known recurring bad dates |
| OCR fragments numbers ("28.02.24" → "2 8. 0 2.24") | `SYSTEM_PROMPT` explicitly tells the LLM to recognise this pattern; keep the rule when editing |
| `ghcr.io/paperless-ngx/tika` requires auth | Use `apache/tika` instead |
| `python` vs `python3` differs across platforms (Git Bash has `python`, macOS has `python3`) | Scripts auto-detect with `command -v python3 \|\| command -v python` |
| Ollama model may return `---\n{...}` (YAML prefix) or integers in tag lists or `null` for empty list fields | Handled in `ollama_backend._clean_json`, `models.CoercedStr`, `models.CoercedList` |
| `pydantic-settings` JSON-parses `list[str]` fields by default — comma-separated env values fail | Annotate with `NoDecode` and use a `field_validator(mode="before")` to split (see `Settings.auto_approve_types`) |
| Restic `--last` flag is deprecated | Use `--latest <N>` |
| Webhook + poller race-enqueue the same doc | Worker re-checks lifecycle tags on dequeue, logs `skip_already_processed` if already processed |
| Same content uploaded twice | Paperless dedups by SHA1 — duplicate is silently dropped, no double-processing |

---

## What's implemented vs planned

| Feature | Status |
|---|---|
| Paperless-ngx deployment | ✅ Running |
| Auto-tagger (Ollama + Anthropic) | ✅ Running |
| 20-type German document taxonomy | ✅ Live |
| Daily backup (Docker crond + restic) | ✅ Running |
| Propagation watcher (ai-approved → native fields) | ✅ Running |
| Confidence-based routing (auto-approve allowlist) | ✅ Running |
| Few-shot exemplars from propagated corpus | ✅ Available (`FEW_SHOT_EXAMPLES > 0`) |
| Per-correspondent history hint | ✅ Default on |
| Webhook trigger from paperless `post_consume_script` | ✅ Running |
| Pytest suite + ruff + GitHub Actions CI | ✅ Running (97+ tests) |
| Custom React/Next.js frontend | 🔲 Planned (apps/web placeholder) |
| Semantic search / RAG | 🔲 Planned |
| HTTPS / Tailscale | 🔲 Planned (TODO in runbook) |
| Backup integrity checks (`restic check`) | 🔲 Planned |
| Health endpoint / Prometheus metrics | 🔲 Planned |

---

## Auto-tagger development workflow

```bash
cd services/auto-tagger
uv sync                          # install incl. dev deps (pytest, ruff, etc.)
uv run pytest                    # ~0.15s, pure-function tests
uv run ruff check                # lint
```

After Python changes: `cd docker && docker compose up -d --build auto-tagger` (the live container won't pick up source edits otherwise).

Test layout (all pure-function, no live HTTP):
- `tests/conftest.py` — `make_settings` fixture
- `tests/test_paperless.py` — normalisers, truncator, lifecycle tags
- `tests/test_tagger.py` — routing matrix, history hint, few-shot rendering, `_split_csv`
- `tests/test_propagator.py` — suggested-tags filter
- `tests/test_models.py` — Pydantic validation (enum, range, coerce)
- `tests/test_webhook.py` — aiohttp handler (auth, queue, /health) via `TestClient`

CI (`.github/workflows/ci.yml`) runs ruff + pytest on push and PR. Action versions are `actions/checkout@v6` and `astral-sh/setup-uv@v7` — both Node-24-runtime to avoid the Node-20 deprecation.

The `tagger.py` per-file `E501` ruff ignore is intentional: `SYSTEM_PROMPT` is a long German-text block where line wrapping damages the prompt as content.
