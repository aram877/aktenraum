# aktenraum — Claude working guide

Self-hosted personal DMS built on Paperless-ngx with an AI classification layer. Everything runs in Docker. Scripts target bash and run on macOS, Linux, or Windows (Git Bash). Deployment target is Docker Desktop or native Linux Docker.

**Deep-dive docs for humans** (skim before changing anything load-bearing — they describe the *why* this guide takes for granted):

- [`docs/workflow.md`](docs/workflow.md) — plain-English "follow one document through the system" walkthrough; start here if you're new
- [`docs/architecture.md`](docs/architecture.md) — services, data flow, lifecycle, RAG pipeline (the reference; workflow.md is the friendly version)
- [`docs/development.md`](docs/development.md) — start/build/test/debug, common tasks
- [`docs/document-types.md`](docs/document-types.md) — the 26 doc types + disambiguation + per-type fields
- [`docs/configuration.md`](docs/configuration.md) — every env var, organised by file
- [`docs/api-reference.md`](docs/api-reference.md) — endpoint catalog with auth + shapes
- [`docs/glossary.md`](docs/glossary.md) — every acronym + framework + piece of jargon used in this repo, plain-language
- [`Taskfile.yml`](Taskfile.yml) — every common workflow as a `task <name>` shortcut

---

## Skills for Claude (auto-invoked from `.claude/skills/<name>/SKILL.md`)

Six project-specific skills capture the patterns and gotchas that recur in this repo. Each loads automatically when its trigger conditions match — e.g. editing `paperless_gw.py` auto-loads `paperless-api-integration`. When in doubt, invoke them explicitly with `/<skill-name>`.

- **[`paperless-api-integration`](.claude/skills/paperless-api-integration/SKILL.md)** — every Paperless REST API gotcha (`?name__iexact=` not `?name=`, custom_fields full-array PATCH replace, monetary/date normalisers, 128-char string limits, longtext fields, `swap_lifecycle_tag` TOCTOU+retry, entity-cache TTL invalidation). Auto-loads when touching `PaperlessClient` or `PaperlessGateway`.
- **[`llm-extraction-fallbacks`](.claude/skills/llm-extraction-fallbacks/SKILL.md)** — the small-LLM field-drop problem rooted in Pydantic defaults, the post-extraction synthesizer pattern (`_synthesize_*`), the OCR-regex heuristic for ref-numbers, and the prompt-tightening conventions. Auto-loads when editing `tagger.py`, `extraction.py`, or investigating "empty `ai_*` field" reports.
- **[`aktenraum-commit-discipline`](.claude/skills/aktenraum-commit-discipline/SKILL.md)** — the project-specific commit rules (never commit before tests, never commit after a bug fix without user confirmation) plus the binding documentation cadence (session note + ADR + CLAUDE.md update in the same commit). Auto-loads before any commit/push.
- **[`fastapi-route-pattern`](.claude/skills/fastapi-route-pattern/SKILL.md)** — the standard router/service/schemas layout, dependency-injection order, gateway-error → HTTP-status mapping (404/409/502), CSRF compatibility, the get-document-then-patch idiom. Auto-loads when editing any `aktenraum_api/*/router.py`.
- **[`lifecycle-tag-state-machine`](.claude/skills/lifecycle-tag-state-machine/SKILL.md)** — the 8 lifecycle/auxiliary tags, valid transitions, who owns each, the `asyncio.shield()` requirement around lifecycle PATCHes, idempotency expectations. Auto-loads when editing `tagger.py`, `propagator.py`, `indexer.py`, `inbox/service.py`, or `swap_lifecycle_tag`.
- **[`spa-data-fetching`](.claude/skills/spa-data-fetching/SKILL.md)** — TanStack Query conventions (query-key shape, invalidation rules, `staleTime` table, dedup-by-key for sharing data across components), TanStack Router lazy-route + `RouteSuspense` wrapper, SSE consumer pattern. Auto-loads when editing `apps/web/src/lib/*.ts`, `apps/web/src/routes/*.tsx`, or `router.tsx`.

---

## Stack (10 services — all in `docker/docker-compose.yml`)

Two Python services (`auto-tagger` for workers, `aktenraum-api` for HTTP) is a deliberate split — see [`docs/adr/004-two-python-services.md`](docs/adr/004-two-python-services.md) for the rationale (process isolation, independent memory caps, independent restart cadence) and the conditions that would justify revisiting it.

External images are pinned by tag-and-digest in `docker/docker-compose.yml` so `latest`-drift can't silently change runtime behaviour; bump with intent.

| Service       | Image                               | Role                                                            | Port                                                 |
| ------------- | ----------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| paperless     | ghcr.io/paperless-ngx/paperless-ngx:2.20.15 | DMS core, OCR, admin UI                                 | `127.0.0.1:8000`                                     |
| postgres      | postgres:15                         | Hosts both `paperless` and `aktenraum` databases                | internal                                             |
| redis         | redis:7                             | Paperless task queue                                            | internal                                             |
| gotenberg     | gotenberg/gotenberg:8.31.0          | PDF conversion                                                  | internal                                             |
| tika          | apache/tika (digest-pinned)         | Document parsing                                                | internal                                             |
| qdrant        | qdrant/qdrant:v1.17.1               | RAG vector store (chunks + payload)                             | internal (6333 REST, 6334 gRPC)                      |
| auto-tagger   | local build                         | AI extraction worker + RAG indexer (event-driven)               | internal                                             |
| aktenraum-api | local build                         | FastAPI HTTP API for the SPA (auth, AI features, RAG retrieval) | internal (8002)                                      |
| nginx         | local build                         | Edge: serves SPA static + reverse-proxies `/api/*`              | `127.0.0.1:8080` (override via `AKTENRAUM_WEB_PORT`) |
| backup        | local build                         | Daily restic backup via crond                                   | internal                                             |

> **Note**: use `apache/tika` — NOT `ghcr.io/paperless-ngx/tika` (requires auth, returns 403).

### Task runner

The root `Taskfile.yml` ([Taskfile.dev](https://taskfile.dev), `brew install go-task`) wraps every common workflow. `task --list` enumerates them. Use these shortcuts in preference to raw commands so future sessions stay consistent:

| Task | Equivalent |
| --- | --- |
| `task start` / `task stop` | friendly aliases for `compose up -d` / `compose down` |
| `task status` | `compose ps` |
| `task recover` | re-mint Paperless API token + restart auto-tagger + aktenraum-api (fixes 401 storms after any DB recreation) |
| `task setup` | complete first-time setup: secrets → stack → token → Paperless bootstrap → backup init → first snapshot |
| `task destroy` | stop stack + delete `AKTENRAUM_DATA_DIR` entirely (prompts for `DELETE` confirmation) |
| `task build` | rebuild everything (nginx/SPA + auto-tagger + aktenraum-api) after code changes |
| `task build:fe` | rebuild frontend only (nginx image with baked SPA) |
| `task build:be` | rebuild backend only (auto-tagger + aktenraum-api) |
| `task up` / `task down` / `task ps` / `task restart` | raw compose lifecycle (lower-level; prefer `start`/`stop`) |
| `task logs SVC=auto-tagger` | tail a single service |
| `task recreate SVC=auto-tagger` | recreate a service after env-file edits (env files are NOT re-read by `restart`) |
| `task web:dev` | Vite hot-reload on `:5173`, bound to `0.0.0.0` so LAN devices can hit it |
| `task web:deploy` / `task nginx:rebuild` | bake the SPA into the nginx image |
| `task api:rebuild` / `task tagger:rebuild` | rebuild + recreate a Python service |
| `task test` / `task test:py` / `task test:web` | full suite or one half |
| `task lint` / `task lint:py` / `task lint:web` | ruff + eslint |
| `task reprocess ID=27` | clear lifecycle tags so the auto-tagger re-extracts |
| `task rag:backfill` / `task rag:eval` | RAG ops |
| `task backup:run` / `task backup:snapshots` | manual backup ops |

### Start / stop (raw)

```bash
cd docker
docker compose up -d          # start all                 (task up)
docker compose down           # stop all (data preserved) (task down)
docker compose up -d --build auto-tagger   # rebuild after code changes (task tagger:rebuild)
docker compose up -d --build backup        # rebuild after backup changes
```

### Logs (raw)

```bash
docker compose logs -f auto-tagger        # task logs SVC=auto-tagger
docker compose logs -f backup
docker compose logs --tail=50 paperless
```

---

## Credentials & secrets

**First-run flow (Phase 0.1, ADR-002).** All runtime secrets except `PAPERLESS_API_TOKEN` are auto-generated by `bash scripts/bootstrap-secrets.sh` — it copies `docker/*.env.example` → `docker/*.env` if absent, fills empty REQUIRED values with `openssl rand`, reconciles cross-file shared secrets (`PAPERLESS_DBPASS`, `WEBHOOK_SECRET`), and prints the auto-generated admin/SPA passwords ONCE for the user to record. The script is idempotent: re-runs are safe no-ops once everything is populated, which is why the future desktop shell will call it on every launch as a safety net. `PAPERLESS_API_TOKEN` still has to be minted via the Paperless API after the paperless container starts (see `scripts/bootstrap-paperless.sh`).

| What                   | Where                                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paperless URL          | http://localhost:8000 (admin UI, only used for backend tasks)                                                                                                                                                                                                       |
| aktenraum URL          | http://localhost:8080 (SPA — primary user interface)                                                                                                                                                                                                                |
| Paperless admin        | `PAPERLESS_ADMIN_USER` / `PAPERLESS_ADMIN_PASSWORD` in `docker/.env`                                                                                                                                                                                                |
| aktenraum admin        | `BOOTSTRAP_USERNAME` / `BOOTSTRAP_PASSWORD` in `docker/aktenraum-api.env` (seeded on first start; ignored once a user exists)                                                                                                                                       |
| aktenraum JWT signing  | `JWT_SECRET` in `docker/aktenraum-api.env` (`openssl rand -base64 32`)                                                                                                                                                                                              |
| Paperless DB password  | `PAPERLESS_DBPASS` in `docker/.env` (also used by aktenraum-api)                                                                                                                                                                                                    |
| Paperless API token    | `PAPERLESS_API_TOKEN` in `docker/auto-tagger.env` (mint via `POST /api/token/` after first paperless boot — example below)                                                                                                                                          |
| Restic passphrase      | `RESTIC_PASSWORD` in `docker/backup.env`                                                                                                                                                                                                                            |
| Webhook secret         | `WEBHOOK_SECRET` in `docker/.env` (passed to paperless's post_consume hook) AND `docker/auto-tagger.env` (must match)                                                                                                                                               |
| LLM backend            | `LLM_BACKEND=ollama` or `anthropic` in `docker/auto-tagger.env` (and, for Phase-2 AI search, in `docker/aktenraum-api.env`)                                                                                                                                         |
| Ollama model           | `OLLAMA_MODEL=qwen2.5:32b-instruct-q8_0` (current recommended default; ~32 GB). Step down to `qwen2.5:14b-instruct-q8_0` (~16 GB) when memory is tight. Smaller models (≤8B) reliably drop schema fields — the Python fallbacks catch them but the output is less specific. |
| AI search → Paperless  | `PAPERLESS_API_TOKEN` in `docker/aktenraum-api.env` — same token the auto-tagger uses; required for `/api/ai/*`                                                                                                                                                     |
| AI search → LLM        | `ANTHROPIC_API_KEY` (when `LLM_BACKEND=anthropic`) or `OLLAMA_BASE_URL` + `OLLAMA_MODEL` (when `LLM_BACKEND=ollama`), all in `docker/aktenraum-api.env`                                                                                                             |
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
- **Paperless's content-OCR date detector cannot be disabled.** It runs in the consumer (`documents/consumer.py:430`) when the parser ships no PDF metadata date and grabs _any_ date from the OCR text. It commonly picks up birthdates from CVs / IDs. Workaround: rely on the AI's `ai_issue_date` being correct so propagation overrides it; for a known recurring bad date use `PAPERLESS_IGNORE_DATES` env var.
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
│           └── models/          # DocumentExtraction, DocumentType enum (26 values), KeyDates, coercion validators
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

### Lifecycle tags (8 total — 6 lifecycle + 2 auxiliary)

| Tag                    | Meaning                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ai-pending`           | Extracted, awaiting human review                                                                                        |
| `ai-approved`          | User approved → propagation watcher will copy to native fields                                                          |
| `ai-rejected`          | User rejected → no propagation, no retry                                                                                |
| `ai-propagated`        | Native correspondent/document_type/tags written; final success state                                                    |
| `ai-propagation-error` | Propagation failed mid-run; manual intervention needed                                                                  |
| `ai-error`             | Extraction failed (LLM error, schema validation, etc.); manual retry by clearing tags                                   |
| `ai-auto-approved`     | Auxiliary flag (not a lifecycle state); set alongside `ai-approved` when confidence ≥ `AUTO_APPROVE_CONFIDENCE` so the SPA can show an "Auto-genehmigt" badge. Persists through propagation. |
| `ai-low-confidence`    | Auxiliary flag (not a lifecycle state); coexists with `ai-pending` to surface uncertain extractions in the review queue |

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

| Condition                                                                        | Tag(s) applied                                  |
| -------------------------------------------------------------------------------- | ----------------------------------------------- |
| `confidence ≥ AUTO_APPROVE_CONFIDENCE` AND `document_type ∈ AUTO_APPROVE_TYPES`  | `ai-approved` (skips review; propagation fires) |
| Otherwise                                                                        | `ai-pending`                                    |
| Additionally if `confidence < LOW_CONFIDENCE_THRESHOLD` (and not auto-approving) | adds `ai-low-confidence`                        |

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

| Env                     | Backend                                       |
| ----------------------- | --------------------------------------------- |
| `LLM_BACKEND=ollama`    | Ollama at `http://host.docker.internal:11434` |
| `LLM_BACKEND=anthropic` | Anthropic API (`claude-sonnet-4-6`)           |

Switch by editing `docker/auto-tagger.env` and running `docker compose up -d auto-tagger` (restart alone does NOT re-read env files — must use `up -d`). After Python source changes also use `--build`.

### Document taxonomy (26 types)

Rechnung · Gehaltsabrechnung · Kontoauszug · Nebenkostenabrechnung · Hausgeldabrechnung · Mahnung · Vertrag · Kündigung · Versicherung · Steuer · Lohnsteuerbescheinigung · Spendenbescheinigung · Bescheid · Behördenbrief · Sozialversicherungsmeldung · Kfz · Bußgeldbescheid · Arztbrief · Krankschreibung · Garantie · Urkunde · Ausweis · Zeugnis · Arbeitszeugnis · Mitgliedschaft · Sonstiges

Defined in `packages/aktenraum-core/src/aktenraum_core/models/extraction.py` `DocumentType` enum. Prompt definitions in `services/auto-tagger/src/auto_tagger/tagger.py` `SYSTEM_PROMPT` (with explicit disambiguation rules — read before editing). Per-type extraction fields in `packages/aktenraum-core/src/aktenraum_core/models/type_schema.py` `TYPE_FIELD_SCHEMA`.

**Gotchas — disambiguation rules baked into SYSTEM_PROMPT**:

- **Meldebescheinigung** has two flavours: the employer's annual "Meldebescheinigung zur Sozialversicherung" (DEÜV §25) → `Sozialversicherungsmeldung`; the Bürgeramt-issued address confirmation → `Behördenbrief`.
- **Lohnsteuerbescheinigung vs. Steuer**: the employer's annual §41b EStG certificate is its own type — keep it out of `Steuer`. `Steuer` is for Steuererklärungen / Anlagen; `Steuerbescheid` (Finanzamt-issued) goes to `Bescheid`.
- **Hausgeldabrechnung vs. Nebenkostenabrechnung**: WEG-Eigentümer get a `Hausgeldabrechnung` from the Hausverwaltung; tenants get a `Nebenkostenabrechnung` from the landlord. Wohngeldbescheid (housing benefit) is a `Bescheid`.
- **Bußgeldbescheid vs. Bescheid**: traffic fines split off into their own type — `Bescheid` is reserved for non-traffic admin acts.
- **Krankschreibung vs. Arztbrief**: short AU-Bescheinigung ("gelber Schein") is `Krankschreibung`; longer medical reports / findings stay in `Arztbrief`.
- **Spendenbescheinigung**: Zuwendungsbestätigung under §50 EStDV — distinct from `Rechnung`, `Mitgliedschaft`, or the user's own `Steuer` filing.

---

## Validation patterns at the LLM/Paperless boundary

Local LLMs (especially small ones like gemma4 8B) emit data the Paperless API rejects on edge cases. We layer two defences: schema-level coercion at the Pydantic boundary, and value normalisation at the PATCH boundary.

| Issue                                                                           | Where                                                             | Fix                                                                                           |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| LLM returns `null` for a list field instead of `[]`                             | `models.CoercedList` (BeforeValidator)                            | Coerces None → []                                                                             |
| LLM returns int in a list of strings (e.g. `[42, "text"]`)                      | `models.CoercedStr` (BeforeValidator)                             | Coerces to str                                                                                |
| LLM emits monetary as German `"149,99 EUR"`; Paperless wants `"EUR149.99"`      | `paperless._normalize_monetary`                                   | Regex parse + ISO-format reformat                                                             |
| LLM emits date as `"01.12.2024"` or `"12-2024"`; Paperless wants `"YYYY-MM-DD"` | `paperless._normalize_date`                                       | strptime against a list of common formats                                                     |
| LLM emits a string longer than Paperless's 128-char custom-field limit          | `paperless.truncate_for_field`                                    | Truncates `string` fields; passes `longtext` fields (e.g. `ai_summary_de`) through unmodified |
| LLM suggests a lifecycle tag (`ai-approved`) as a real tag                      | `propagator._split_suggested_tags`                                | Filter out lifecycle names                                                                    |
| LLM suggests a tag truncated by the 128-char limit (ends with `…`)              | `propagator._split_suggested_tags`                                | Drop fragments ending in ellipsis                                                             |
| Paperless 4xx hides the validation reason                                       | `paperless.patch_document_native_fields` + `_get_or_create_named` | Log response body via `paperless_patch_rejected` / `paperless_create_rejected` events         |

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

**Distribution direction (binding)**: aktenraum is being built for sale as a Tauri desktop app wrapping the Docker Compose stack — not as a Docker tarball. See `docs/adr/002-distribution-desktop-app.md` for the constraints this places on every change (no committed secrets, configurable data dir, idempotent first-run, model auto-pull, etc.) and `docs/plans/desktop-app.md` for the phased roadmap. **Phase 0 — self-bootstrapping compose — is the unblocker; nothing Tauri-specific lands until Phase 0 is done.** **Currently deferred per [ADR-005](docs/adr/005-test-phase-access-via-tailscale.md): during the testing phase the maintainer validates the product via Tailscale-mediated remote access (`docs/runbooks/tailscale-remote-access.md`); Phase 0 resumes when the milestones listed in ADR-005 are met.**

**RAG direction (binding)**: the answer pipeline is being upgraded to production-grade local retrieval — Qdrant + bge-m3 (dense+sparse) + bge-reranker-v2-m3 + hybrid query-time retrieval, all running locally via Ollama. See `docs/plans/rag-phase-1.md` for the architecture, schema, sub-phasing (1.1–1.12), and the eval harness that gates merges. The current Q&A pipeline (`/api/ai/answer/stream`) only sees AI metadata; RAG Phase 1 indexes the full OCR'd text so questions whose answers live in the document body (CV employment durations, contract clauses, etc.) start working.

**Documentation cadence (binding)**: every working session ends with a session summary at `docs/sessions/YYYY-MM-DD.md` listing what shipped, by feature, with commit hashes; a "things to pick up next session" block; and the active roadmap progress for any plan in `docs/plans/`. Architectural decisions go to `docs/adr/NNN-name.md` (template at `docs/adr/000-template.md`). Multi-phase initiatives go to `docs/plans/<topic>.md`. Whenever a session changes any of these (new feature, new gotcha, new constraint, finished phase), CLAUDE.md is updated in the same commit so future sessions see current state without trawling git log.

Use `/openspec-propose` skill to create a full change in one step.
Use `/opsx:apply` skill to implement tasks from an approved change.

---

## Known gotchas

| Issue                                                                                                       | Fix                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`AKTENRAUM_DATA_DIR` unset on Windows causes silent data loss** — `${HOME}` resolves differently from Git Bash vs PowerShell vs Task runner, so each `docker compose up` may write postgres to a new path and initialise a fresh empty DB, abandoning the old data (two incidents: May 20, May 23 2026) | Set `AKTENRAUM_DATA_DIR=D:/aktenraum` (or your chosen Windows path) in `docker/.env`. The `.env.example` now has this line uncommented with a warning. Never change it without migrating the data directory first. |
| Restic backup repo must be initialised once before any snapshot — `backup` container's `entrypoint.sh` runs `restic backup` but NOT `restic init`; on a fresh volume the repo is empty and all backups silently no-op | `task setup` includes the init step (idempotent). Manual: `docker compose exec backup sh -c 'restic -r /repo snapshots >/dev/null 2>&1 \|\| restic -r /repo init'` then `task backup:run` |
| `docker compose restart` doesn't re-read env files                                                          | Use `docker compose up -d` to recreate the container                                                                                                                                            |
| Python source changes don't take effect on restart                                                          | `docker compose up -d --build auto-tagger` to rebuild                                                                                                                                           |
| Git Bash converts `/usr/local/bin/...` to Windows path in `docker exec`                                     | Prefix with `MSYS_NO_PATHCONV=1` and use `//usr/local/bin/...`                                                                                                                                  |
| Paperless `?name=` filter is silently ignored on `/api/tags/` (returns first page regardless)               | Use `?name__iexact=<name>`; keep the Python equality re-check as defence in depth                                                                                                               |
| Paperless `data_type=string` custom fields have a hard 128-char limit                                       | Use `truncate_for_field` at the boundary; ellipsis on overflow. Use `data_type=longtext` (Paperless 2.x+) for fields that need more — extend the `LONGTEXT_FIELDS` set so truncation is skipped |
| Paperless `data_type=monetary` requires `<ISO><amount>` format                                              | Use `_normalize_monetary`                                                                                                                                                                       |
| Paperless `data_type=date` requires strict YYYY-MM-DD                                                       | Use `_normalize_date`                                                                                                                                                                           |
| Paperless's content-OCR date detector cannot be turned off via env var                                      | Rely on AI extracting `ai_issue_date` correctly so propagation overrides; or use `PAPERLESS_IGNORE_DATES` for known recurring bad dates                                                         |
| OCR fragments numbers ("28.02.24" → "2 8. 0 2.24")                                                          | `SYSTEM_PROMPT` explicitly tells the LLM to recognise this pattern; keep the rule when editing                                                                                                  |
| `ghcr.io/paperless-ngx/tika` requires auth                                                                  | Use `apache/tika` instead                                                                                                                                                                       |
| `python` vs `python3` differs across platforms (Git Bash has `python`, macOS has `python3`)                 | Scripts auto-detect with `command -v python3 \|\| command -v python`                                                                                                                            |
| Ollama model may return `---\n{...}` (YAML prefix) or integers in tag lists or `null` for empty list fields | Handled in `ollama_backend._clean_json`, `models.CoercedStr`, `models.CoercedList`                                                                                                              |
| `pydantic-settings` JSON-parses `list[str]` fields by default — comma-separated env values fail             | Annotate with `NoDecode` and use a `field_validator(mode="before")` to split (see `Settings.auto_approve_types`)                                                                                |
| Restic `--last` flag is deprecated                                                                          | Use `--latest <N>`                                                                                                                                                                              |
| Webhook + poller race-enqueue the same doc                                                                  | Worker re-checks lifecycle tags on dequeue, logs `skip_already_processed` if already processed                                                                                                  |
| Same content uploaded twice                                                                                 | Paperless dedups by SHA1 — duplicate is silently dropped, no double-processing                                                                                                                  |
| **CSRF middleware blocks browser requests with `Sec-Fetch-Site: cross-site`** on state-changing methods + `/preview` + `/download` | Internal callers (auto-tagger webhook, paperless `post_consume`) bypass by including `X-Aktenraum-Secret`. See ADR-003. Tauri WebView will need the same header or a same-origin proxy. |
| `PaperlessClient` entity caches (tag id, custom field id, name maps) are TTL'd 5 min by default            | After out-of-band Paperless changes (`scripts/bootstrap-paperless.sh`, manual delete), call `client.invalidate_caches()` or wait one TTL; the gateway also auto-refreshes on unknown-field warnings |
| Auto-approve requires BOTH `AUTO_APPROVE_CONFIDENCE` AND non-empty `AUTO_APPROVE_TYPES` allowlist           | Empty list (the default) disables auto-approve entirely. The type gate defends against prompt-injection that emits `confidence=0.99`                                                            |
| `COOKIE_SECURE` defaults to `True`                                                                          | Localhost dev sets `COOKIE_SECURE=false` in `docker/aktenraum-api.env` to allow login over plain http://localhost:8080; production HTTPS deploys leave it unset                                  |
| Login appears to succeed but every API call returns 401 — auth cookie set, never sent                       | Cause is `COOKIE_SECURE=true` (the default) combined with plain-HTTP access (typically `http://<lan-ip>:8080` from a non-host device). The browser refuses to send a `Secure` cookie over plain HTTP, so login looks like it works then bounces indefinitely. Fix: use the Tailscale MagicDNS HTTPS URL (`https://<host>.<tailnet>.ts.net/`) instead. Do NOT flip `COOKIE_SECURE=false` to "fix" this — that weakens security for no reason. See `docs/runbooks/tailscale-remote-access.md` failure-mode appendix. |
| `swap_lifecycle_tag` can raise `PaperlessConflictError` (HTTP 409) under heavy concurrency                  | Three-attempt verify-and-retry built in; if the third attempt still races, the SPA surfaces a "refresh and try again" message                                                                   |
| nginx `client_max_body_size 500m` caps total multipart upload size                                          | Per-file limit (`upload_max_file_bytes`, 25 MB default) and file-count limit (`upload_max_files_per_request`, 20) enforced server-side; MIME content-type allowlist rejects unknown formats     |
| Small LLMs (≤8B) drop `summary_de`, `reference_numbers`, `suggested_tags` despite the prompt rule           | Tagger has post-extraction fallbacks: `_synthesize_summary_de` (deterministic German summary from struct fields) + `_extract_reference_numbers_from_text` (regex sweep over OCR for Aktenzeichen/Rechnungsnr./Vertragsnr./Kundennr./Vorgangsnr./Bestellnr./Auftragsnr./Policennr./Steuernr.). Logs `summary_de_synthesized` / `reference_numbers_harvested` when they fire. `suggested_tags` has no synthesis fallback — risk of fabricating useless tags is higher than benefit |
| Approve action feels laggy (up to 30s before propagation)                                                   | The `POST /api/inbox/{id}/approve` handler fires a best-effort `POST /trigger/propagate` against auto-tagger (`AUTO_TAGGER_URL`, default `http://auto-tagger:8001`). If `WEBHOOK_SECRET` is set in `docker/aktenraum-api.env` but differs from the value in `docker/auto-tagger.env`, the trigger returns 401 and propagation silently falls back to the 30s safety-net poller. Symptom: approve returns 200 but the doc takes up to 30s to flip from `ai-approved` → `ai-propagated`. Fix: ensure both env files have the same `WEBHOOK_SECRET` (or both empty); `bootstrap-secrets.sh` reconciles them automatically.                                                                                                                                                                                                                                                |
| **`DELETE /api/documents/{id}/` is a soft-delete, not hard-delete** — Paperless 2.x always moves to `/api/trash/` | The previous `paperless_gw.delete_document` docstring claimed "no soft-delete", which was wrong. Hard-delete only happens via `POST /api/trash/` with `action: "empty"` — the trash service does that AND `vector_store.delete_by_doc_id` on the SPA's "Endgültig löschen" / "Papierkorb leeren" paths. Without an empty step, soft-deleted docs auto-purge after `PAPERLESS_EMPTY_TRASH_DELAY` days (default 30). Note: a soft-deleted doc's Qdrant chunks remain in the index until the empty step runs — RAG retrieval can still surface "trashed" content until the user actually empties. Real fix is a follow-up (query-time exclusion or a chunk-payload `trashed` flag). |
| Auto-approve doesn't fire on a Rechnung you expected to skip review                                          | `docker compose logs auto-tagger \| grep routing_decision` and read the `reason=…` field on the matching `doc_id` line. Closed-enum values: `auto_approved` (gate passed), `allowlist_empty` (set `AUTO_APPROVE_TYPES` in `docker/auto-tagger.env`), `type_not_in_allowlist` (the LLM picked a doc type that isn't in your allowlist — add it or accept the review queue), `confidence_below_threshold` (LLM gave the doc a low score — inspect `ai_confidence` and `ai_confidence_reason` in the inbox detail to see why). Routing logic itself is correct and tested; the reason field tells you which gate blocked the doc.                                                                                                                                                                                                                                  |
| Un-tagging `ai-duplicate` in Paperless doesn't make a pair stop being flagged                                | v1 has no dismissal store — the detector compares fields against the propagated corpus on every propagation. If you remove `ai-duplicate` from doc A but doc B is still in the corpus with matching fields, the NEXT propagation that lands against the same correspondent will re-tag A (and B if their tag was also cleared). Workarounds: hard-delete one of the pair, OR live with re-tagging until v2 ships a dismissal table. Untagging IS sticky as long as no new propagation in that correspondent runs; the re-flag is event-driven, not periodic.                                                                                                                                                                                                                                                                                            |

---

## What's implemented vs planned

| Feature                                                                                         | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paperless-ngx deployment                                                                        | ✅ Running                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Auto-tagger (Ollama + Anthropic)                                                                | ✅ Running                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 26-type German document taxonomy                                                                | ✅ Live                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Daily backup (Docker crond + restic)                                                            | ✅ Running                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Propagation watcher (ai-approved → native fields)                                               | ✅ Running                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Confidence-based routing (auto-approve allowlist)                                               | ✅ Running                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Few-shot exemplars from propagated corpus                                                       | ✅ Available (`FEW_SHOT_EXAMPLES > 0`)                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Per-correspondent history hint                                                                  | ✅ Default on                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Webhook trigger from paperless `post_consume_script`                                            | ✅ Running                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Pytest suite + ruff + GitHub Actions CI                                                         | ✅ Running (239 tests)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Custom Vite + React SPA shell                                                                   | ✅ Running (`apps/web`, served by nginx on `:8080`)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Find docs (`/api/ai/find` + `/find` page)                                                       | ✅ Phase 2 — closed-enum SearchFilter, editable chips, Open + Download per result                                                                                                                                                                                                                                                                                                                                                                                             |
| Ask AI conversational Q&A (`/api/ai/answer` + `/ask`)                                           | ✅ Phase 2.5 — German prose answer with citations; small model for filter, big model for answer                                                                                                                                                                                                                                                                                                                                                                               |
| Document preview/download proxies (`/api/documents/{id}/{preview,download}`)                    | ✅ Reusable across Ask/Find/Inbox/Library; token never reaches the browser                                                                                                                                                                                                                                                                                                                                                                                                    |
| Inbox review queue (`/api/inbox/*` + `/inbox` + `/inbox/$id`)                                   | ✅ Phase 3 — two-pane PDF preview, editable AI fields, approve/reject, keyboard shortcuts                                                                                                                                                                                                                                                                                                                                                                                     |
| Library / Bibliothek (`/api/library/` + `/library`)                                             | ✅ Filterable list of all non-pending docs; URL-state filters; row click → `/library/$id` two-pane review (PDF + editable AI fields, Save / Reset / Reprocess / Download). **Sortierung** dropdown (6 options: `-created` default, `created`, `-modified`, `modified`, `title`, `-title`) persisted via `?ordering=…`. **In-flight pin**: on `page=1` the server fetches the auto-tagger's `/processing` slots (extraction + propagation + indexer) and prepends those docs as `is_processing=true` rows, de-duped against the natural sort — so a doc the worker is actively handling never gets buried by pagination. |
| Upload (`POST /api/documents/upload` + `/upload`)                                               | ✅ Drag-and-drop dropzone, single + multi-file, per-file progress + status, isolated failures; uploads stream through aktenraum-api so the Paperless token stays server-side                                                                                                                                                                                                                                                                                                  |
| Mobile document scan (`/scan`)                                                                  | ✅ Phase 1 — `<input type="file" accept="image/*" capture="environment">` invokes the OS camera; thumbnail grid with ↑↓ reorder / rotate / crop / delete; filename input defaults `scan-YYYY-MM-DD-HHmmss`; **client-side PDF composition via `pdf-lib`** (decode → rotate+crop on canvas → JPEG 0.85 → embed in A4-portrait page with letterboxing, downscale longest side to 3200 px); uploads through the existing `/api/documents/upload` endpoint with **zero backend changes**. `pdf-lib` (~187 KB gzip) lives in the lazy-loaded `Scan-<hash>.js` route chunk, NOT the main bundle. Crop modal uses `react-image-crop` (full-screen, rectangular crop only in v1). MAX_PAGES=30. Phase 2 (auto edge-detection + perspective correction via lazy-loaded `jscanify` + OpenCV.js, ~8 MB chunk) planned in `openspec/changes/mobile-document-scan/` task group 6; ships only after Phase 1 settles. |
| Reprocess (`POST /api/documents/{id}/reprocess`)                                                | ✅ Clears all 7 lifecycle tags; pings auto-tagger webhook (with optional `WEBHOOK_SECRET`) for instant turnaround; falls back to the 30s poller. Reprocess button on the preview modal                                                                                                                                                                                                                                                                                        |
| Processing visibility (`/documents/in-flight`, `/task/{uuid}`, `/{id}/status`, ProcessingBadge) | ✅ DocumentSummary carries `lifecycle_tags`; shared SPA badge (Wartet auf KI / Wird übertragen / Verarbeitet / In Inbox / Fehler / etc.) renders on Library rows + Find/Ask cards; Upload page polls task → doc-status → lifecycle for live progress; Nav shows a global "N in Bearbeitung" pill, refetched every 30s                                                                                                                                                         |
| RAG retrieval (Qdrant + bge-m3 + bge-reranker-v2-m3)                                            | ✅ Phase 1 — chunker, embedder, vector store, indexer task in auto-tagger, backfill script, hybrid retrieval, reranker, eval harness all live. `/api/ai/answer/stream` serves chunk-grounded answers with `[Quelle: <id>]` citations. Opt-in via `QDRANT_URL` (set in compose by default; empty disables and falls back to AI-metadata-only path). 10/12 sub-phases done; 1.11 (model auto-pull) joins desktop-app 0.3, 1.12 (docs) ongoing. See `docs/plans/rag-phase-1.md`. |
| RAG eval harness                                                                                | ✅ Phase 1.10 — `python -m aktenraum_api.eval.runner` (or `bash scripts/run-rag-eval.sh`) reports recall@K + MRR over `evals/golden-questions.yaml`. JSON output for CI threshold gates.                                                                                                                                                                                                                                                                                      |
| Confidence-vs-correctness eval (`scripts/eval-confidence-correlation.py`)                       | ✅ Available — joins `ai_confidence` against an "approved-unedited" proxy (correspondent + doctype match) over the propagated corpus, emits CSV + Pearson. Initial run on n=19 shows confidence clustered at ~0.978 (zero variance) so Pearson is meaningless until the corpus diversifies. **Decision criterion**: re-evaluate auto-approve routing once N≥50 docs span all three buckets; if Pearson <~0.3 then `AUTO_APPROVE_CONFIDENCE` is gating on noise and should be retired in favour of rule-based allowlists. Until then, keep `AUTO_APPROVE_TYPES` empty (the default) so auto-approve stays off in practice. |
| Papierkorb / Trash (`/api/trash/*` + `/trash` page)                                             | ✅ Two-step delete model: Löschen on the preview / library row moves the doc to Paperless's trash (recoverable for `PAPERLESS_EMPTY_TRASH_DELAY` days, default 30); `/trash` lists trashed docs with per-row Wiederherstellen / Endgültig löschen and a top-bar Papierkorb leeren modal. Endgültig löschen and Empty trash hard-delete in Paperless AND purge the doc's Qdrant chunks via `vector_store.delete_by_doc_id` (best-effort: Qdrant cleanup failure logs `trash_qdrant_purge_failed` but never fails the user request). Nav-bar Papierkorb badge polls `?page_size=1` on the same 30s cadence as the in-flight pill. |
| Duplikat-Erkennung (`ai-duplicate` aux tag)                                                     | ✅ v1 field-based detector at `services/auto-tagger/src/auto_tagger/dedup.py`. Runs inline in `propagator.process_approved_document` after every successful propagation: fetches up to 200 `ai-propagated` docs filtered to the new doc's correspondent, and flags pairs that share correspondent + `ai_issue_date` AND ((monetary amounts within 0.01 EUR) OR (any `ai_reference_numbers` overlap). Both pair members are tagged `ai-duplicate` (idempotent). The tag is in `_BADGE_TAGS` so Library rows render a purple pill; the user filters via `/library?tags=ai-duplicate` and resolves via the existing Löschen → Papierkorb flow. **v1 limitations**: no dismissal store (untagging in Paperless is best-effort; a future propagation against the matched doc will re-tag), no text-similarity for OCR-drifted dates/amounts, no backfill script for the existing corpus, no dedicated "Mögliche Duplikate" view. Skipped when the new doc has no `ai_correspondent` or `ai_issue_date`. |
| Email ingestion (IMAP → consume pipeline)                                                       | ✅ Opt-in via `AKTENRAUM_MAIL_*` in `docker/.env`. `scripts/bootstrap-paperless.sh` auto-loads those vars and provisions a Paperless mail account + rule (idempotent: re-runs reconcile drift incl. password rotation). Paperless polls the mailbox every ~10 minutes; attachments matching `*.pdf,*.png,*.jpg,*.jpeg,*.tif,*.tiff` flow through the same consume pipeline as the watched folder (SHA1 dedup, OCR, auto-tagger). Each ingested doc gets the `email-ingested` tag (sky blue, `#0ea5e9`) so the user can filter via `/library?tags=email-ingested`. Rule defaults: INBOX, MARK_READ after consume, max 30 days history on first poll, filename-as-title. Provider-agnostic — Gmail (App Password), Outlook, Fastmail, self-hosted IMAP. Unsetting `AKTENRAUM_MAIL_IMAP_SERVER` does NOT delete an existing account; remove via Paperless's admin UI. |
| Remote access via Tailscale (testing-phase topology)                                            | ✅ Runbook + ADR-005 — `tailscale serve --bg --https=443 http://localhost:8080` on the host, `https://<host>.<tailnet>.ts.net/` from any tailnet device. No public exposure. See `docs/runbooks/tailscale-remote-access.md` and `docs/adr/005-test-phase-access-via-tailscale.md`. Shortcuts: `task tailscale:serve` / `task tailscale:status`.                                                                                                                                |
| Self-service password change (`POST /api/auth/change-password` + Konto section on `/settings`)  | ✅ Verifies current password + min 8-char new password + `new != current`. Success clears the session cookie (forces re-login on the current device; other devices' JWTs expire on their own at the 8h default). No DB schema change. Replaces the previous "edit bcrypt hash via psql" workaround for password rotation.                                                                                                                                                       |
| Mobile responsiveness (`md:` breakpoint = 768px, `lg:` = 1024px)                                | ✅ Nav collapses to hamburger drawer below `md:`. Library archive: sidebar collapses behind a "Filter & Tags" toggle on mobile; table swaps to a card-list (one `<li>` per doc). Library review tab: same table-to-cards swap. Inbox/Library detail pages: stacked two-pane gets a "PDF / Bearbeiten" tab toggle below `lg:` so the user isn't scrolling past a full-height iframe to reach the form. Keyboard-shortcut hints in detail pages are `hidden md:inline` (no kbd on phones). DocumentPreviewModal is full-screen below `sm:` (no rounded corners, no padding). Touch targets bumped to 40-44px on mobile via responsive `h-10 w-10 sm:h-auto sm:w-auto` pattern. All other pages (Login / Home / Ask / Find / Trash / Upload / Settings) verified mobile-OK with the existing single-column layouts. |
| Backup integrity checks (`restic check`)                                                        | 🔲 Planned                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Health endpoint / Prometheus metrics                                                            | 🔲 Planned                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

---

## Auto-tagger development workflow

Run all Python commands from the **repository root** — it is the uv workspace root and the workspace shares one `uv.lock` and one `.venv` across `packages/aktenraum-core` and `services/auto-tagger`.

```bash
uv sync                          # install incl. dev deps (pytest, ruff, etc.) for both members
uv run pytest                    # task test:py — full suite across both members
uv run ruff check                # task lint:py — lint both members
```

After Python changes: `task tagger:rebuild` (or `cd docker && docker compose up -d --build auto-tagger`). The Dockerfile build context is the repo root, so edits to either `services/auto-tagger/src/` or `packages/aktenraum-core/src/` are picked up by the rebuild.

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
pnpm install                                          # task web:install
pnpm --filter @aktenraum/web dev                      # task web:dev   — vite on :5173, bound to 0.0.0.0
                                                      # proxies /api → http://localhost:8080 (nginx)
pnpm --filter @aktenraum/web build                    # task web:build — production bundle into apps/web/dist
pnpm --filter @aktenraum/web lint                     # task web:lint
pnpm --filter @aktenraum/web generate:api-types       # task web:types — codegen TS types from /api/openapi.json
```

For a full-stack dev cycle, keep the compose stack up (`task up`), then run `task web:dev` for hot-reloaded SPA changes. Two Vite knobs control proxy + LAN exposure: `VITE_API_PROXY_TARGET` (default `http://localhost:8080`; honour `AKTENRAUM_WEB_PORT`) and `VITE_HOST` (default `0.0.0.0`). Vite accepts any `Host` header so a second device hitting `http://<dev-machine-ip>:5173` works without further config.

Production deploys go through the nginx container, which builds the SPA in a multi-stage Docker build — no Node runtime needed at deploy time. Run `task web:deploy` after SPA changes when you are NOT using the dev server.

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
- `SearchFilter` is closed-enum: `document_type` reuses `aktenraum_core.models.DocumentType`, plus `correspondent`, `date_from`, `date_to`, `text`, `tags`. Unknown doc types → 422. Cross-type amount filtering was removed when the generic `monetary_amount` field was retired — money lives on type-specific schemas only (Rechnung.gesamtbetrag, Mahnung.forderungsbetrag, etc.).
- Server-side `PaperlessGateway` (`aktenraum_api.paperless_gw`) holds the API token; per-process correspondent / tag / custom-field-id caches; the token never reaches the SPA.
- Translator (`aktenraum_api.ai.translate`) → Paperless query params using `document_type__id` / `correspondent__id` (the bare names are silently ignored — same gotcha class as `?name=` on `/api/tags/`).
- Prompt (`aktenraum_api.ai.prompt`) inlines the doc-type taxonomy, the live correspondent list (cap 200), date rules, and a few German few-shot exemplars. An explicit note tells the LLM there are no amount fields on the filter. **Modular extras**: `ai.intent.detect_intents(query)` runs a German keyword classifier (`SALARY` / `SPENDING` / `TAX` / `INSURANCE` / `HOUSING` / `MEDICAL` / `ID_DOCUMENT` / `CAR` / `CONTRACT`); whenever an intent fires, the matched `ai.prompt_modules.MODULES[doc_type].filter_examples` are appended to the few-shot block so the LLM sees a typed mapping for the shape at hand. Neutral queries fall through to the static set unchanged (prompt-cache stable). Substring match by default — short ambiguous keywords (`pass`, `lohn`) opt into strict whole-word matching via `_STRICT_KEYWORDS`.

### AI: Conversational answer (`/api/ai/answer`)

- `POST /api/ai/answer` runs a two-step pipeline: filter extraction → retrieval → second LLM call that reads the AI metadata of the top matches and produces a German prose answer with citations.
- Response shape: `{question, answer_de, citations: list[DocumentSummary], filter, total}`. Hallucinated citation ids are dropped server-side (intersection with the searched docs).
- Retrieval broadens the filter for the answer step: when any structural field (doc_type, correspondent, dates, amounts) is set, we drop the `text` constraint — verbs like "verlängern" / "kostete" land in `text` from the filter LLM but rarely appear in OCR'd content, so keeping them kills recall. `/find` keeps `text` honored.
- The answer prompt (`aktenraum_api.ai.answer_prompt`) is **assembled per request from `ai.prompt_modules.MODULES`**: `_assembled_field_hints(candidates)` enumerates each distinct doc type present in the retrieved set, lists its `TYPE_FIELD_SCHEMA` labels and the module's `answer_hint` in the system message; `_assembled_examples(candidates, json_mode=...)` emits one module example per distinct type in the user message. `_to_json_envelope` lets the JSON `/answer` and streaming `/answer/stream` paths share the same per-type examples without duplicating strings. The static cross-doc aggregation example (Wizz-Air style) and the citation-marker rule stay always-on — they teach syntax, not domain. Module entries cover every `DocumentType` enum value (import-time guard `_assert_all_doc_types_covered`); field labels come from `TYPE_FIELD_SCHEMA` so adding a typespecific field there automatically widens the prompt.
- Two LLM backends: the filter-extraction call uses `OLLAMA_MODEL` / `ANTHROPIC_MODEL`; the answer call optionally uses `OLLAMA_ANSWER_MODEL` / `ANTHROPIC_ANSWER_MODEL` so a deployer can pair a fast 8B for filters with a smarter 14B+ for answers (the 8B is too small to read citations reliably).

### AI: Streaming answer + RAG (`/api/ai/answer/stream`)

The user-facing /ask page consumes this endpoint, NOT `/api/ai/answer`. The streaming variant adds two things:

1. **SSE token-by-token streaming.** Replaces the silent ~30s wait with `meta` → repeated `chunk` → `final` (or `error`) events. Inline `[Quelle: <id>]` markers in the streamed prose are regex-extracted post-hoc and intersected with retrieved docs to populate citations. The streaming-specific prompt (`build_streaming_answer_messages`) instructs the model to use the marker format and is prose-only (NOT JSON envelope).
2. **RAG retrieval (Phase 1).** When `QDRANT_URL` is set, every question runs through `aktenraum_api.ai.retrieval.retrieve_chunks_for_question`: embed query (bge-m3) → Qdrant search top-50 with payload filter → bge-reranker-v2-m3 cross-encoder rerank → top-5 chunks. Those chunks land under "Relevante Auszüge:" inside each candidate's prompt block, alongside the existing AI metadata fields. This is what answers questions whose information is in the document body (CV employment durations, contract clauses, table values) — pre-RAG the LLM only ever saw `ai_summary_de` + dates + amounts.

Resilience: any RAG stage failing degrades gracefully (embedder error → empty result, qdrant error → skip rerank, reranker error → fall through to dense-only ordering). Empty / `QDRANT_URL`-unset → falls back to the AI-metadata-only path so the endpoint keeps working.

The bge-reranker-v2-m3 model is **pre-warmed in lifespan** as a background task (`aktenraum_api.main._warm_reranker`) so the first `/ask` after a fresh container is not blocked by the ~2.1 GB HF download (568M parameters, fp32 weights). The download lands in the `aktenraum-hf-cache` named volume (mounted at `/home/appuser/.cache/huggingface`, pinned via `HF_HOME` / `HUGGINGFACE_HUB_CACHE`), so it survives `docker compose up -d --build aktenraum-api`. End-to-end warm took ~80s on the dev host on first run; subsequent rebuilds are instant because the cache persists. Steady-state rerank is ~50 ms × 50 candidates ≈ 2.5s. If a request lands while the warm-up is still running the reranker's `asyncio.Lock` makes it wait on the in-flight load instead of starting a second one. **Volume permissions gotcha**: a fresh named volume mounts as root-owned; the Dockerfile pre-creates `/home/appuser/.cache/huggingface` with `appuser` ownership so Docker copies the right mode into the volume on first attach. If you ever see `reranker_prewarm_failed` with a `PermissionError`, the volume was created before the Dockerfile fix — `docker volume rm docker_aktenraum-hf-cache` and rebuild.

**Denial suppresses citations.** When the answer LLM writes the prompt-baked "I couldn't find that" template (`_DENIAL_RE` in `router.py` — matches "in den Dokumenten nicht finden", "keine passenden Dokumente", "keines der Dokumente enthält", and three more variants, length-capped at 200 chars), the no-citations back-fill is skipped and the SPA renders the denial alone. Without this gate the back-fill rule ("if the model wrote prose but cited nothing, surface the retrieved set so the user has a source to verify against") rendered source cards beneath a "nicht gefunden" message, which looked like the AI was lying about its own search. The gate is strict — partial answers longer than 200 chars that happen to contain a denial phrase still get their citations back-filled.

### RAG: indexing pipeline (auto-tagger)

Indexing fans out from propagation. When a doc reaches `ai-propagated`, the propagator enqueues its id on the `indexing_queue`; a fifth concurrent task in the auto-tagger drains the queue and runs:

```
fetch document by id from Paperless
  ↓
chunk content (paragraph-aware, ~500 tokens, ~50-token overlap)
  ↓
batch-embed via Ollama bge-m3 (single round-trip per doc)
  ↓
delete-by-doc-id from Qdrant (idempotent: re-index never duplicates)
  ↓
upsert with denormalised payload (doc_type, correspondent, tags, created_date)
```

Failures tag `ai-index-error` (auxiliary, NOT in `LIFECYCLE_TAGS`); success self-heals — clears the error tag if previously set. Cap of 200 chunks per doc protects against runaway OCR.

**Opt-in via `QDRANT_URL`**: empty (or unset) disables the indexer worker and the propagator hook, so the existing extraction + propagation paths keep working when RAG is intentionally off.

### RAG: backfill the existing corpus

Newly-propagated docs index automatically; the existing corpus needs a one-shot. From repo root:

```bash
bash scripts/backfill-rag-index.sh           # idempotent, skip already-indexed
bash scripts/backfill-rag-index.sh --force   # re-index everything
```

JSON-line events on stdout: `started → doc_skipped|doc_indexed|doc_failed* → completed`. Resumable: re-running on a fully-indexed corpus is a fast no-op (one cheap Qdrant `count` per doc, then skip).

### RAG: eval harness

Measures retrieval quality so prompt / model / chunker changes are evaluable rather than vibes-only.

```bash
bash scripts/run-rag-eval.sh                 # text report
bash scripts/run-rag-eval.sh --json          # CI-friendly JSON
```

Cases live in `evals/golden-questions.yaml` (bind-mounted into the api container at `/app/evals/`). Each case: `id`, `question`, `expected_doc_ids`, optional `expected_in_top_k` (default 5). Multi-doc-expected supported (a question that could legitimately be answered by either of two filings).

Output: per-case rank + hit/miss + aggregate `recall@K` and `MRR` (mean reciprocal rank). Exit code is 0 regardless of metrics — the wrapper / CI decides the threshold.

The committed YAML is keyed to the dev maintainer's local Paperless ids; buyers / new collaborators copy to a private location and re-pin against their own corpus.

### Library (`/api/library/`)

- `GET /api/library/` — paginated list of non-pending documents. Server-side excludes `ai-pending` via `tags__id__none=<ai-pending-id>` so anything still under review never reaches the library.
- Query params: `document_type`, `correspondent`, `date_from`, `date_to`, `text`, `tags`, `page` (≥1), `page_size` (1..100), `ordering` (allowlist: `-created`, `created`, `-modified`, `modified`, `title`, `-title`). Cross-type amount filtering was retired with the generic `monetary_amount` field.
- Returns `LibraryItem` rows with `lifecycle_tags` so the SPA can render a small badge per tag (propagated / approved / rejected / error). Falls back to AI custom-field correspondent / doc_type when the native FK is unset.
- Money is no longer exposed at this layer — type-specific schemas carry it (Rechnung.gesamtbetrag, Mahnung.forderungsbetrag, Versicherung.jahrespraemie, etc.). The Library detail page surfaces them via `TypeSpecificFieldsSection`.
- SPA route `/library` keeps filter state in URL search params (bookmarkable; back-button works); auto-applies form changes after a 400ms debounce; click row → `/library/$id`.
- `/library/$id` is the per-document review: PDF iframe on the left, editable form for the 12 AI fields on the right (Save / Reset / Erneut verarbeiten / Download / Back). Backed by `GET /api/documents/{id}/detail` and `PATCH /api/documents/{id}/fields` — both reuse `aktenraum_api.inbox.service` so they work on any doc, not just pending. Edits update only the AI fields; the propagator only runs on `ai-approved`, so to also rewrite the native Paperless fields the user clicks **Erneut verarbeiten** (which restarts the full pipeline). The page closes the same `DocumentPreviewModal` Find / Ask citation cards still use for quick looks.

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
- Nav shows a global "N in Bearbeitung" pill (in-flight count minus inbox count, so it represents docs the _auto-tagger_ is processing right now — pending docs already get the Inbox badge). React-Query refetches every 30s.

### Document proxy (`/api/documents/{id}/{preview,download}`)

- `GET /api/documents/{id}/preview` streams the inline PDF preview (`Content-Type: application/pdf`, `Cache-Control: private, max-age=300`). Used by the Ask / Find / Inbox preview modal.
- `GET /api/documents/{id}/download` streams the original file with the upstream `Content-Disposition` forwarded so the browser saves with the right filename.
- Both proxy through `aktenraum-api` so the Paperless API token stays server-side. nginx's `proxy_read_timeout` is bumped to 300s in `docker/nginx/nginx.conf` because LLM-backed endpoints can take ~30s on bigger local models.

Without `PAPERLESS_API_TOKEN` set, `/api/ai/*` and `/api/documents/*` respond 503 while `/api/health` and `/api/auth/*` stay green. Same for missing `ANTHROPIC_API_KEY` when `LLM_BACKEND=anthropic`.

### Inbox review (`/api/inbox/*`)

- `GET /api/inbox/` paginated list of `ai-pending` documents (oldest-first); `GET /api/inbox/{id}` full review payload (12 ai\_\* fields + content excerpt + tags); `PATCH /api/inbox/{id}` partial field update; `POST /api/inbox/{id}/approve` (optional patch body, then swaps `ai-pending` → `ai-approved`); `POST /api/inbox/{id}/reject`; `GET /api/inbox/{id}/preview` streams the PDF with `Content-Type: application/pdf`, `Cache-Control: private, max-age=300`. All auth-gated.
- Lifecycle-tag swap is a single `tags=[…]` PATCH planned by `_plan_tag_swap` (pure helper). Idempotent re-approve / re-reject is a no-op.
- **Paperless `custom_fields` PATCH is full-array replace**, not partial upsert — sending only `{ai_correspondent: …}` would wipe the other 11 fields. The gateway's `patch_document_custom_fields` reads the existing array, merges the requested updates by field id (`_merge_custom_fields`), then writes back. Same gotcha class as the silent `?name=` and `?correspondent=` filters.
- Field-update normalisation reuses `aktenraum_core.paperless.normalisers` — date fields go strict ISO, monetary becomes `<ISO><amount>`, strings get truncated to 128 chars. Server-side at the boundary; client cannot bypass.
- SPA: the review queue lives at `/library?tab=review` (the `ZurPruefungTab` inside `apps/web/src/routes/Library.tsx`). The legacy `/inbox` URL is a redirect-only route (no component) that bounces to `/library?tab=review` so old bookmarks keep working — `routes/Inbox.tsx` was deleted. The list supports **multi-select bulk approve**: per-row checkboxes + a header "select all" checkbox + a sticky dark action bar that runs `useBulkApprove` (parallel POSTs against `/api/inbox/{id}/approve`) and reports `N genehmigt · M fehlgeschlagen`. **Pagination is load-more, not page-jump**: the tab uses `useInboxListInfinite` (TanStack `useInfiniteQuery`, pageSize=50) so multi-select spans loaded chunks naturally — review is a triage flow, not random-access browsing. "Mehr anzeigen" button below the table renders while `hasNextPage`; counter shows `N von M geladen`. Bulk-approve `invalidateQueries({queryKey: INBOX_KEY})` invalidates all loaded pages, triggering a sequential refetch (acceptable: refetch only fires once per bulk operation, and the refetched state is usually much smaller because most loaded docs just got approved). Per-doc detail page is `/inbox/$id` — two-pane review (PDF iframe via the proxy + editable form), keyboard shortcuts `a` Approve / `r` Reject / `j`,`k` next/prev / `Esc` back. Auto-advance to the next pending doc on action; back-out / Escape navigate directly to `/library?tab=review` (no redirect hop).

The `tagger.py` per-file `E501` ruff ignore is intentional: `SYSTEM_PROMPT` is a long German-text block where line wrapping damages the prompt as content.

## COMMIT AND PUSH RULES

- NEVER EVER commit anything before running tests locally..
- NEVER EVER commit after fixing a bug without me first confirming that the bug is fixed
