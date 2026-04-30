# aktenraum — Claude working guide

Self-hosted personal DMS built on Paperless-ngx with an AI classification layer. Everything runs in Docker. Scripts target bash and run on macOS, Linux, or Windows (Git Bash). Deployment target is Docker Desktop or native Linux Docker.

---

## Stack (9 services — all in `docker/docker-compose.yml`)

| Service | Image | Role | Port |
|---|---|---|---|
| paperless | ghcr.io/paperless-ngx/paperless-ngx | DMS core, OCR, admin UI | `127.0.0.1:8000` |
| postgres | postgres:15 | Hosts both `paperless` and `aktenraum` databases | internal |
| redis | redis:7 | Paperless task queue | internal |
| gotenberg | gotenberg/gotenberg:8 | PDF conversion | internal |
| tika | apache/tika | Document parsing | internal |
| auto-tagger | local build | AI extraction worker (event-driven) | internal |
| aktenraum-api | local build | FastAPI HTTP API for the SPA (auth, AI features) | internal (8002) |
| nginx | local build | Edge: serves SPA static + reverse-proxies `/api/*` | `127.0.0.1:8080` (override via `AKTENRAUM_WEB_PORT`) |
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
| Paperless URL | http://localhost:8000 (admin UI, only used for backend tasks) |
| aktenraum URL | http://localhost:8080 (SPA — primary user interface) |
| Paperless admin | `PAPERLESS_ADMIN_USER` / `PAPERLESS_ADMIN_PASSWORD` in `docker/.env` |
| aktenraum admin | `BOOTSTRAP_USERNAME` / `BOOTSTRAP_PASSWORD` in `docker/aktenraum-api.env` (seeded on first start; ignored once a user exists) |
| aktenraum JWT signing | `JWT_SECRET` in `docker/aktenraum-api.env` (`openssl rand -base64 32`) |
| Paperless DB password | `PAPERLESS_DBPASS` in `docker/.env` (also used by aktenraum-api) |
| Paperless API token | `PAPERLESS_API_TOKEN` in `docker/auto-tagger.env` (mint via `POST /api/token/` after first paperless boot — example below) |
| Restic passphrase | `RESTIC_PASSWORD` in `docker/backup.env` |
| Webhook secret | `WEBHOOK_SECRET` in `docker/.env` (passed to paperless's post_consume hook) AND `docker/auto-tagger.env` (must match) |
| LLM backend | `LLM_BACKEND=ollama` or `anthropic` in `docker/auto-tagger.env` (and, for Phase-2 AI search, in `docker/aktenraum-api.env`) |
| Ollama model | `OLLAMA_MODEL=gemma4:latest` (what we run); larger models or `qwen` family work too |
| AI search → Paperless | `PAPERLESS_API_TOKEN` in `docker/aktenraum-api.env` — same token the auto-tagger uses; required for `/api/ai/*` |
| AI search → LLM | `ANTHROPIC_API_KEY` (when `LLM_BACKEND=anthropic`) or `OLLAMA_BASE_URL` + `OLLAMA_MODEL` (when `LLM_BACKEND=ollama`), all in `docker/aktenraum-api.env` |
| AI answer → bigger LLM | Optional `OLLAMA_ANSWER_MODEL` / `ANTHROPIC_ANSWER_MODEL` overrides the model used by `/api/ai/answer` only — pair a fast small model for filter extraction with a smarter big one for prose answers (8B is too small to read citations reliably; 14B+ recommended) |

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

- **`?name=` is silently ignored on `/api/tags/`** — it returns the default first page regardless. Use `?name__iexact=<name>` for exact match. The Python-side equality check stays as defence in depth (see `aktenraum_core.paperless.client._get_or_create_named`).
- **Custom fields with `data_type=string` have a hard 128-char DB limit.** Anything longer 400s the entire PATCH. We truncate at the boundary with `_truncate_string_field` (in `aktenraum_core.paperless.normalisers`, ellipsis at 128 chars). The complementary `data_type=longtext` (Paperless 2.x+) has no length cap; fields backed by it must NOT be truncated. Use `truncate_for_field(name, value)` at the boundary — it consults the `LONGTEXT_FIELDS` allowlist (currently `{"ai_summary_de"}`) and skips truncation for those. To add a new longtext field: extend `LONGTEXT_FIELDS`, add the matching `ensure_custom_field … "longtext"` line in `scripts/bootstrap-paperless.sh`, and run `scripts/migrate-ai-summary-to-longtext.sh` (rename for the new field) to migrate existing installs.
- **Custom fields with `data_type=monetary` require the format `<ISO_CODE><amount>`** (e.g., `EUR149.99`) — the German format `149,99 EUR` is rejected. We normalise via `_normalize_monetary` (handles symbols, German/Anglophone thousands separators).
- **Custom fields with `data_type=date` require strict YYYY-MM-DD.** German `DD.MM.YYYY`, slashes, month-year-only all rejected. We normalise via `_normalize_date`.
- **Paperless's content-OCR date detector cannot be disabled.** It runs in the consumer (`documents/consumer.py:430`) when the parser ships no PDF metadata date and grabs *any* date from the OCR text. It commonly picks up birthdates from CVs / IDs. Workaround: rely on the AI's `ai_issue_date` being correct so propagation overrides it; for a known recurring bad date use `PAPERLESS_IGNORE_DATES` env var.
- **Custom fields data type cannot be changed after creation.** Plan field types up front; recreate to migrate.
- **OCR fragments numbers with spaces** ("28.02.24" → "2 8. 0 2.24"). The system prompt explicitly tells the LLM to recognise this; keep that rule when editing.

---

## Directory layout

```
/
├── pyproject.toml               # uv workspace root (no project of its own)
├── uv.lock                      # workspace-wide lockfile
├── .python-version              # 3.13
├── .github/
│   └── workflows/ci.yml         # uv setup → ruff check → pytest (workspace-root)
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
├── packages/
│   └── aktenraum-core/          # shared Python lib — uv workspace member
│       └── src/aktenraum_core/
│           ├── llm/             # AnthropicBackend, OllamaBackend, base Protocol, factory
│           ├── paperless/       # client.py (PaperlessClient + LIFECYCLE_TAGS), normalisers.py
│           └── models/          # DocumentExtraction, DocumentType enum (20 values), KeyDates, coercion validators
├── services/
│   └── auto-tagger/             # Python 3.13, uv workspace member
│       ├── src/auto_tagger/
│       │   ├── config.py        # Pydantic BaseSettings (all env vars)
│       │   ├── tagger.py        # German prompt + routing + few-shot + history hint
│       │   ├── propagator.py    # ai-approved → native fields + ai-propagated
│       │   ├── webhook.py       # aiohttp listener for paperless's post_consume hook
│       │   └── main.py          # asyncio.gather of extraction worker, poller, propagation, http server
│       ├── tests/               # pytest suite — pure-function, no live HTTP
│       │   ├── conftest.py      # `make_settings` fixture used across files
│       │   ├── test_models.py   # DocumentExtraction validation (imports from aktenraum_core.models)
│       │   ├── test_paperless.py# normalisers + LIFECYCLE_TAGS (imports from aktenraum_core.paperless)
│       │   ├── test_propagator.py# suggested-tags filter
│       │   ├── test_tagger.py   # routing matrix + history hint + few-shot rendering
│       │   └── test_webhook.py  # aiohttp handler (auth, queue, /health)
│       └── Dockerfile           # python:3.13-slim + uv, non-root user (build context = repo root)
├── apps/
│   └── web/                     # placeholder — Vite + React SPA scaffolded in Phase 1
├── docs/
│   ├── adr/                     # Architecture Decision Records
│   ├── plans/
│   │   └── custom-frontend.md   # multi-phase roadmap for the AI-first SPA replacement
│   └── runbooks/                # first-time-setup, operations, restore, rotate-keys
├── scripts/
│   ├── setup.sh                 # create ~/aktenraum/ dirs
│   ├── bootstrap-paperless.sh   # create AI custom fields + tags via API
│   └── backup.sh                # host-side manual backup (mirrors container logic)
└── openspec/
    └── changes/                 # aktenraum-foundation, backup-timer (completed) + extract-aktenraum-core (in flight)
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
| LLM emits a string longer than Paperless's 128-char custom-field limit | `paperless.truncate_for_field` | Truncates `string` fields; passes `longtext` fields (e.g. `ai_summary_de`) through unmodified |
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
Completed changes: `aktenraum-foundation`, `backup-timer`. In flight: `extract-aktenraum-core` (foundation for the custom-frontend roadmap; see `docs/plans/custom-frontend.md`).

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
| Paperless `data_type=string` custom fields have a hard 128-char limit | Use `truncate_for_field` at the boundary; ellipsis on overflow. Use `data_type=longtext` (Paperless 2.x+) for fields that need more — extend the `LONGTEXT_FIELDS` set so truncation is skipped |
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
| Pytest suite + ruff + GitHub Actions CI | ✅ Running (231 tests) |
| Custom Vite + React SPA shell | ✅ Running (`apps/web`, served by nginx on `:8080`) |
| Find docs (`/api/ai/find` + `/find` page) | ✅ Phase 2 — closed-enum SearchFilter, editable chips, Open + Download per result |
| Ask AI conversational Q&A (`/api/ai/answer` + `/ask`) | ✅ Phase 2.5 — German prose answer with citations; small model for filter, big model for answer |
| Document preview/download proxies (`/api/documents/{id}/{preview,download}`) | ✅ Reusable across Ask/Find/Inbox/Library; token never reaches the browser |
| Inbox review queue (`/api/inbox/*` + `/inbox` + `/inbox/$id`) | ✅ Phase 3 — two-pane PDF preview, editable AI fields, approve/reject, keyboard shortcuts |
| Library / Bibliothek (`/api/library/` + `/library`) | ✅ Filterable list of all non-pending docs (doc type, correspondent, date range, amount, free text); URL-state filters; click row → preview modal |
| Upload (`POST /api/documents/upload` + `/upload`) | ✅ Drag-and-drop dropzone, single + multi-file, per-file progress + status, isolated failures; uploads stream through aktenraum-api so the Paperless token stays server-side |
| Reprocess (`POST /api/documents/{id}/reprocess`) | ✅ Clears all 7 lifecycle tags; pings auto-tagger webhook (with optional `WEBHOOK_SECRET`) for instant turnaround; falls back to the 30s poller. Reprocess button on the preview modal |
| Processing visibility (`/documents/in-flight`, `/task/{uuid}`, `/{id}/status`, ProcessingBadge) | ✅ DocumentSummary carries `lifecycle_tags`; shared SPA badge (Wartet auf KI / Wird übertragen / Verarbeitet / In Inbox / Fehler / etc.) renders on Library rows + Find/Ask cards; Upload page polls task → doc-status → lifecycle for live progress; Nav shows a global "N in Bearbeitung" pill, refetched every 30s |
| Semantic search / RAG | 🔲 Planned (Phase 6, only if structured-filter search hits a ceiling) |
| HTTPS / Tailscale | 🔲 Planned (TODO in runbook) |
| Backup integrity checks (`restic check`) | 🔲 Planned |
| Health endpoint / Prometheus metrics | 🔲 Planned |

---

## Auto-tagger development workflow

Run all Python commands from the **repository root** — it is the uv workspace root and the workspace shares one `uv.lock` and one `.venv` across `packages/aktenraum-core` and `services/auto-tagger`.

```bash
uv sync                          # install incl. dev deps (pytest, ruff, etc.) for both members
uv run pytest                    # full suite across both members (testpaths set in root pyproject.toml)
uv run ruff check                # lint both members
```

After Python changes: `cd docker && docker compose up -d --build auto-tagger`. The Dockerfile build context is the repo root, so edits to either `services/auto-tagger/src/` or `packages/aktenraum-core/src/` are picked up by the rebuild.

Test layout (all pure-function, no live HTTP):
- `services/auto-tagger/tests/conftest.py` — `make_settings` fixture
- `services/auto-tagger/tests/test_paperless.py` — normalisers, truncator, lifecycle tags (imports from `aktenraum_core.paperless` + `aktenraum_core.paperless.normalisers`)
- `services/auto-tagger/tests/test_tagger.py` — routing matrix, history hint, few-shot rendering, `_split_csv`
- `services/auto-tagger/tests/test_propagator.py` — suggested-tags filter
- `services/auto-tagger/tests/test_models.py` — Pydantic validation (imports from `aktenraum_core.models`)
- `services/auto-tagger/tests/test_webhook.py` — aiohttp handler (auth, queue, /health) via `TestClient`

`aktenraum-core` does not yet have its own test suite; tests for the moved modules continue to live under `services/auto-tagger/tests/` and are kept there until `aktenraum-core` grows core-only behaviour worth covering separately.

CI (`.github/workflows/ci.yml`) runs two jobs on push and PR: `python` (ruff + pytest from the workspace root) and `web` (`pnpm install` + lint + build). Action versions are `actions/checkout@v6` and `astral-sh/setup-uv@v7` — both Node-24-runtime to avoid the Node-20 deprecation.

---

## Frontend (SPA) development workflow

The SPA lives at `apps/web/` (Vite + React 19 + TypeScript + Tailwind v4 + TanStack Router + TanStack Query). All commands run from the repo root.

```bash
pnpm install                              # install workspace deps
pnpm --filter @aktenraum/web dev          # vite dev server on :5173
                                          # proxies /api → http://localhost:8080 (the running nginx)
pnpm --filter @aktenraum/web build        # production build into apps/web/dist
pnpm --filter @aktenraum/web lint         # eslint
pnpm --filter @aktenraum/web generate:api-types
                                          # codegen TS types from /api/openapi.json (compose stack must be running)
```

For a full-stack dev cycle, keep the compose stack up (`docker compose up -d`) so the API is reachable, then run `pnpm dev` for hot-reloaded SPA changes. Production deploys go through the nginx container, which builds the SPA in a multi-stage Docker build — no Node runtime needed at deploy time.

---

## aktenraum-api notes

- FastAPI app factory at `aktenraum_api.main:create_app()`. The CLI entrypoint (`aktenraum-api`) calls it and runs uvicorn on port 8002.
- Auth: HS256 JWT in an httpOnly `SameSite=Lax` cookie. The SPA never reads the token. `JWT_SECRET` is required at startup; missing/empty → the service exits non-zero.
- Bootstrap: on lifespan startup, if `users` is empty AND `BOOTSTRAP_USERNAME` + `BOOTSTRAP_PASSWORD` are set, one user is inserted. Idempotent across restarts.
- DB: SQLAlchemy 2 async + asyncpg. Engine and sessionmaker live on `app.state` (no module globals); `get_session` reads the sessionmaker from `request.app.state.session_factory`.
- Migrations: Alembic under `services/aktenraum-api/alembic/`. The container entrypoint runs `alembic upgrade head` before starting uvicorn.
- The `aktenraum` Postgres database is created by `docker/postgres-init/01-create-aktenraum-db.sh` on a fresh `pgdata` volume. **For existing installs**, run once: `docker compose exec postgres psql -U paperless -c "CREATE DATABASE aktenraum OWNER paperless;"`

### AI: Find docs (`/api/ai/find`)

- `POST /api/ai/find` is the structured-search endpoint. Auth-gated. Accepts either `{"query": str}` (LLM path) or `{"filter": SearchFilter}` (no LLM, used for chip-edit re-runs). Returns `{filter, results, explanation, total}`.
- `SearchFilter` is closed-enum: `document_type` reuses `aktenraum_core.models.DocumentType`, plus `correspondent`, `date_from`, `date_to`, `min_amount`, `max_amount`, `text`. Unknown doc types → 422.
- Server-side `PaperlessGateway` (`aktenraum_api.paperless_gw`) holds the API token; per-process correspondent / tag / custom-field-id caches; the token never reaches the SPA.
- Translator (`aktenraum_api.ai.translate`) → Paperless query params using `document_type__id` / `correspondent__id` (the bare names are silently ignored — same gotcha class as `?name=` on `/api/tags/`). Amount bounds are post-filter against `ai_monetary_amount`.
- Prompt (`aktenraum_api.ai.prompt`) inlines all 20 doc types, the live correspondent list (cap 200), date/amount rules, and four German few-shot exemplars.

### AI: Conversational answer (`/api/ai/answer`)

- `POST /api/ai/answer` runs a two-step pipeline: filter extraction → retrieval → second LLM call that reads the AI metadata of the top matches and produces a German prose answer with citations.
- Response shape: `{question, answer_de, citations: list[DocumentSummary], filter, total}`. Hallucinated citation ids are dropped server-side (intersection with the searched docs).
- Retrieval broadens the filter for the answer step: when any structural field (doc_type, correspondent, dates, amounts) is set, we drop the `text` constraint — verbs like "verlängern" / "kostete" land in `text` from the filter LLM but rarely appear in OCR'd content, so keeping them kills recall. `/find` keeps `text` honored.
- The answer prompt (`aktenraum_api.ai.answer_prompt`) ships three German few-shot exemplars showing question→field mappings ("Wann läuft … ab?" → Ablauf field, "Was hat … gekostet?" → Betrag, "Bis wann muss ich zahlen?" → Fällig).
- Two LLM backends: the filter-extraction call uses `OLLAMA_MODEL` / `ANTHROPIC_MODEL`; the answer call optionally uses `OLLAMA_ANSWER_MODEL` / `ANTHROPIC_ANSWER_MODEL` so a deployer can pair a fast 8B for filters with a smarter 14B+ for answers (the 8B is too small to read citations reliably).

### Library (`/api/library/`)

- `GET /api/library/` — paginated list of non-pending documents. Server-side excludes `ai-pending` via `tags__id__none=<ai-pending-id>` so anything still under review never reaches the library.
- Query params: `document_type`, `correspondent`, `date_from`, `date_to`, `min_amount`, `max_amount`, `text`, `page` (≥1), `page_size` (1..100), `ordering` (allowlist: `-created`, `created`, `-modified`, `modified`, `title`, `-title`).
- Returns `LibraryItem` rows with `lifecycle_tags` so the SPA can render a small badge per tag (propagated / approved / rejected / error). Falls back to AI custom-field correspondent / doc_type when the native FK is unset.
- Amount is post-filter against `ai_monetary_amount` (Paperless can't filter monetary custom fields server-side); when a bound is set, `total` reflects the post-filter survivor count.
- SPA route `/library` keeps filter state in URL search params (bookmarkable; back-button works); auto-applies form changes after a 400ms debounce; click row → `DocumentPreviewModal` (Esc closes, Download button on the modal header).

### Upload + Reprocess (`/api/documents/upload`, `/api/documents/{id}/reprocess`)

- `POST /api/documents/upload` accepts `multipart/form-data` with one or many `files`; each is forwarded to Paperless's `/api/documents/post_document/`. Per-file failures are isolated — the response is `{results: [{filename, status, task_id, detail}]}`. Paperless dedupes by SHA1 so re-uploading the same content is a silent no-op.
- `POST /api/documents/{id}/reprocess` clears every lifecycle tag (`ai-pending`/`ai-approved`/`ai-rejected`/`ai-propagated`/`ai-propagation-error`/`ai-error` plus `ai-low-confidence`) so the document looks fresh to the auto-tagger; then best-effort pings `http://auto-tagger:8001/trigger/extract` for instant re-extraction. Without the ping (or if it fails) the auto-tagger's 30s poller picks the doc up regardless.
- New env: `AUTO_TAGGER_URL` (default `http://auto-tagger:8001`) and `WEBHOOK_SECRET` (must match auto-tagger's; empty disables the secret on both sides). Both optional.
- SPA: `/upload` route with drag-and-drop + per-file progress; "Erneut verarbeiten" button on `DocumentPreviewModal` (Library / Find / Ask citation cards) with a confirm step. Reprocess success invalidates the `library` and `inbox` query caches so the UI snaps to the new state.

### Processing visibility (`/api/documents/in-flight`, `/task/{uuid}`, `/{id}/status`)

- `GET /api/documents/in-flight` returns `{count}` — number of docs carrying `ai-pending` or `ai-approved` (driven by `tags__id__in`). Empty lifecycle tags are intentionally excluded so legacy / non-AI docs don't keep the Nav badge stuck >0.
- `GET /api/documents/task/{uuid}` proxies Paperless's `/api/tasks/?task_id=…` and projects to `{task_id, status, doc_id, result}`. `doc_id` comes from `related_document` when present, falling back to a regex on the result string ("Success. New document id 19 created") so older Paperless versions still surface a usable id.
- `GET /api/documents/{id}/status` is a lightweight `{id, lifecycle_tags}` lookup used by the upload-page poller.
- `DocumentSummary` (returned by `/find`, `/answer` citations, the preview modal) now carries `lifecycle_tags` so a single `ProcessingBadge` component renders the same status pill everywhere a doc card appears (Library rows, Find result cards, Ask citations). Empty list → "Wartet auf KI".
- SPA upload polling: after `/documents/upload` returns the Paperless task UUID, poll `/task/{uuid}` every 1.5s until SUCCESS, then poll `/{doc_id}/status` every 3s until a lifecycle tag appears or the 120s ceiling hits. The page renders one of: `Bereit → Wird hochgeladen → Paperless verarbeitet… → KI klassifiziert… → ✓ in der Inbox / ✓ in der Bibliothek / ✗ Fehler` per file.
- Nav shows a global "N in Bearbeitung" pill (in-flight count minus inbox count, so it represents docs the *auto-tagger* is processing right now — pending docs already get the Inbox badge). React-Query refetches every 30s.

### Document proxy (`/api/documents/{id}/{preview,download}`)

- `GET /api/documents/{id}/preview` streams the inline PDF preview (`Content-Type: application/pdf`, `Cache-Control: private, max-age=300`). Used by the Ask / Find / Inbox preview modal.
- `GET /api/documents/{id}/download` streams the original file with the upstream `Content-Disposition` forwarded so the browser saves with the right filename.
- Both proxy through `aktenraum-api` so the Paperless API token stays server-side. nginx's `proxy_read_timeout` is bumped to 300s in `docker/nginx/nginx.conf` because LLM-backed endpoints can take ~30s on bigger local models.

Without `PAPERLESS_API_TOKEN` set, `/api/ai/*` and `/api/documents/*` respond 503 while `/api/health` and `/api/auth/*` stay green. Same for missing `ANTHROPIC_API_KEY` when `LLM_BACKEND=anthropic`.

### Inbox review (`/api/inbox/*`)

- `GET /api/inbox/` paginated list of `ai-pending` documents (oldest-first); `GET /api/inbox/{id}` full review payload (12 ai_* fields + content excerpt + tags); `PATCH /api/inbox/{id}` partial field update; `POST /api/inbox/{id}/approve` (optional patch body, then swaps `ai-pending` → `ai-approved`); `POST /api/inbox/{id}/reject`; `GET /api/inbox/{id}/preview` streams the PDF with `Content-Type: application/pdf`, `Cache-Control: private, max-age=300`. All auth-gated.
- Lifecycle-tag swap is a single `tags=[…]` PATCH planned by `_plan_tag_swap` (pure helper). Idempotent re-approve / re-reject is a no-op.
- **Paperless `custom_fields` PATCH is full-array replace**, not partial upsert — sending only `{ai_correspondent: …}` would wipe the other 11 fields. The gateway's `patch_document_custom_fields` reads the existing array, merges the requested updates by field id (`_merge_custom_fields`), then writes back. Same gotcha class as the silent `?name=` and `?correspondent=` filters.
- Field-update normalisation reuses `aktenraum_core.paperless.normalisers` — date fields go strict ISO, monetary becomes `<ISO><amount>`, strings get truncated to 128 chars. Server-side at the boundary; client cannot bypass.
- SPA `/inbox` lists pending docs; `/inbox/$id` is a two-pane review (PDF iframe via the proxy + editable form). Keyboard shortcuts: `a` Approve, `r` Reject, `j`/`k` next/prev, `Esc` back to list. Auto-advance to the next pending doc on action.

The `tagger.py` per-file `E501` ruff ignore is intentional: `SYSTEM_PROMPT` is a long German-text block where line wrapping damages the prompt as content.
