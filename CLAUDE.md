# aktenraum — Claude working guide

Self-hosted personal DMS built on Paperless-ngx with an AI classification layer. Everything runs in Docker. The application code is TypeScript end to end — NestJS API, Node worker, Nuxt/Vue SPA, one shared library — in a single pnpm workspace. Scripts target bash and run on macOS, Linux, or Windows (Git Bash). Deployment target is Docker Desktop or native Linux Docker.

**Deep-dive docs for humans** (skim before changing anything load-bearing — they describe the *why* this guide takes for granted):

- [`docs/workflow.md`](docs/workflow.md) — plain-English "follow one document through the system" walkthrough; start here if you're new
- [`docs/architecture.md`](docs/architecture.md) — services, data flow, lifecycle, RAG pipeline (the reference; workflow.md is the friendly version)
- [`docs/development.md`](docs/development.md) — start/build/test/debug, common tasks
- [`docs/document-types.md`](docs/document-types.md) — the 27 doc types + disambiguation + per-type fields
- [`docs/configuration.md`](docs/configuration.md) — every env var, organised by file
- [`docs/api-reference.md`](docs/api-reference.md) — endpoint catalog with auth + shapes
- [`docs/glossary.md`](docs/glossary.md) — every acronym + framework + piece of jargon used in this repo, plain-language
- [`docs/architecture-diagram.md`](docs/architecture-diagram.md) — the stack as diagrams (Mermaid topology + lifecycle, D2, ASCII, simplified, C4 L1/L2) with a shared legend
- [`Taskfile.yml`](Taskfile.yml) — every common workflow as a `task <name>` shortcut

---

## Skills for Claude (auto-invoked from `.claude/skills/<name>/SKILL.md`)

Six project-specific skills capture the patterns and gotchas that recur in this repo. Each loads automatically when its trigger conditions match — e.g. editing `paperless.gateway.ts` auto-loads `paperless-api-integration`. When in doubt, invoke them explicitly with `/<skill-name>`.

- **[`paperless-api-integration`](.claude/skills/paperless-api-integration/SKILL.md)** — every Paperless REST API gotcha (`?name__iexact=` not `?name=`, custom_fields full-array PATCH replace, monetary/date normalisers, 128-char string limits, longtext fields, `swapLifecycleTag` TOCTOU+retry, entity-cache TTL invalidation). Auto-loads when touching `PaperlessClient` or `PaperlessGateway`.
- **[`llm-extraction-fallbacks`](.claude/skills/llm-extraction-fallbacks/SKILL.md)** — the small-LLM field-drop problem, the post-extraction synthesizer pattern, the OCR-regex heuristic for ref-numbers, and the prompt-tightening conventions. Auto-loads when editing `services/auto-tagger/src/{prompt,extract,synthesizers}.ts` or investigating "empty `ai_*` field" reports.
- **[`aktenraum-commit-discipline`](.claude/skills/aktenraum-commit-discipline/SKILL.md)** — the project-specific commit rules (never commit before tests, never commit after a bug fix without user confirmation) plus the binding documentation cadence. Auto-loads before any commit/push.
- **[`nestjs-route-pattern`](.claude/skills/nestjs-route-pattern/SKILL.md)** — the standard controller/service/schemas layout, DI order, gateway-error → HTTP-status mapping (404/409/502), the FastAPI-compatible `{detail}` error shape, CSRF compatibility, the get-document-then-patch idiom, and the pg-mem test harness. Auto-loads when editing any `services/aktenraum-api/src/*/*.controller.ts`.
- **[`lifecycle-tag-state-machine`](.claude/skills/lifecycle-tag-state-machine/SKILL.md)** — the 8 lifecycle/auxiliary tags, valid transitions, who owns each, cancellation semantics around lifecycle PATCHes, idempotency expectations. Auto-loads when editing `extract.ts`, `propagate.ts`, `indexer.ts`, `inbox.service.ts`, or `swapLifecycleTag`.
- **[`spa-data-fetching`](.claude/skills/spa-data-fetching/SKILL.md)** — `@tanstack/vue-query` conventions for the Nuxt SPA (query-key shape, invalidation rules, `staleTime` table, reactive query keys via getters/`computed`), route middleware, client-only plugins, the SSE consumers, and the `mountSuspended` testing rules. Auto-loads when editing `apps/web/app/composables/*.ts`, `apps/web/app/pages/**/*.vue` or `apps/web/app/plugins/*.ts`.

---

## Stack (10 services — all in `docker/docker-compose.yml`)

Two Node services (`auto-tagger` for background work, `aktenraum-api` for HTTP) is a deliberate split — see [`docs/adr/004-two-python-services.md`](docs/adr/004-two-python-services.md) for the rationale (process isolation, independent memory caps, independent restart cadence). The rationale survived the TypeScript migration unchanged; only the runtime differs.

Paperless, Gotenberg and Tika are pinned by tag-and-digest in `docker/docker-compose.yml`; Postgres, Redis, Qdrant and the Dockerfile base images (`node:22-*`, `nginx:alpine`, `alpine`) are tag-only, so a rebuild can pull a newer patch. Bump with intent.

| Service       | Image                               | Role                                                            | Port                                                 |
| ------------- | ----------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| paperless     | ghcr.io/paperless-ngx/paperless-ngx:2.20.15 | DMS core, OCR, admin UI                                 | `127.0.0.1:8000`                                     |
| postgres      | postgres:15                         | Hosts both `paperless` and `aktenraum` databases                | internal                                             |
| redis         | redis:7                             | Paperless task queue                                            | internal                                             |
| gotenberg     | gotenberg/gotenberg:8.31.0          | PDF conversion                                                  | internal                                             |
| tika          | apache/tika (digest-pinned)         | Document parsing                                                | internal                                             |
| qdrant        | qdrant/qdrant:v1.17.1               | RAG vector store (chunks + payload)                             | internal (6333 REST, 6334 gRPC)                      |
| auto-tagger   | local build (Node 22)               | AI extraction worker + RAG indexer (event-driven)               | internal                                             |
| aktenraum-api | local build (Node 22)               | NestJS HTTP API for the SPA (auth, AI features, RAG retrieval)  | internal (8002)                                      |
| nginx         | local build                         | Edge: serves SPA static + reverse-proxies `/api/*`              | `127.0.0.1:8080` (override via `AKTENRAUM_WEB_PORT`) |
| backup        | local build                         | Daily restic backup via crond                                   | internal                                             |

> **Note**: use `apache/tika` — NOT `ghcr.io/paperless-ngx/tika` (requires auth, returns 403).

### Task runner

The root `Taskfile.yml` ([Taskfile.dev](https://taskfile.dev), `brew install go-task`) wraps every common workflow. `task --list` enumerates them. Use these shortcuts in preference to raw commands so future sessions stay consistent:

| Task | What it does |
| --- | --- |
| `task start` / `task stop` / `task status` | bring the stack up (also recreates any service whose `docker/.env` values changed), take it down (data preserved), see what is running |
| `task logs SVC=auto-tagger` | tail one service; omit `SVC` for all of them |
| `task build` | rebuild and restart everything (nginx/SPA + both Node services) |
| `task web:dev` | Nuxt dev server on `:4300`, proxying `/api` to the nginx edge on `:8080` (`nitro.devProxy` in `apps/web/nuxt.config.ts`) |
| `task test` / `task lint` | vitest and eslint across all four packages (runs `pnpm install` first). One package: `pnpm --filter @aktenraum/api test` |
| `task setup` | complete first-time setup: secrets → stack → token → Paperless bootstrap → backup init → first snapshot |
| `task recover` | re-mint the Paperless API token + restart both Node services (fixes 401 storms after any DB recreation) |
| `task destroy` | stop the stack and delete `AKTENRAUM_DATA_DIR` entirely (prompts for `DELETE`) |
| `task rag:reembed` | drop the Qdrant collection and re-embed everything (run after an embedding-model/dimension change; prompts first) |
| `task backup:verify` | non-destructive DR rehearsal: `restic check` + restore to staging + validate both DB dumps |

Without a task (from repo root; `DC` = `docker compose --project-directory docker`):

| Need | Raw command |
| --- | --- |
| Hot-reload both Node services (`tsx watch`, a `.ts` save reloads in ~1s) / back to prod | `DC -f docker/docker-compose.yml -f docker/docker-compose.dev.yml up -d aktenraum-api auto-tagger` / `DC up -d aktenraum-api auto-tagger` |
| Worker e2e against a **throwaway** stack (`docker/docker-compose.e2e.yml`, project `aktenraum-e2e`, ports 8100/8101/8102/6433; refuses live-stack ports) / tear it down | `bash scripts/e2e-worker.sh` / `bash scripts/e2e-worker.sh --down` |
| Index the existing corpus into Qdrant / score retrieval against `evals/golden-questions.yaml` | `bash scripts/backfill-rag-index.sh` / `bash scripts/run-rag-eval.sh` |
| Manual backup snapshot / list snapshots / integrity check | `DC exec backup /usr/local/bin/entrypoint.sh` / `DC exec -e RESTIC_REPOSITORY=/repo backup restic snapshots --tag aktenraum` / `DC exec -e RESTIC_REPOSITORY=/repo backup restic check --read-data-subset=5%` (Git Bash: prefix `MSYS_NO_PATHCONV=1`, use `//usr/...`) |
| psql shell / one-shot query | `DC exec postgres psql -U paperless -d aktenraum` / `DC exec postgres psql -U paperless -d aktenraum -c "…"` |
| Re-extract one document | "Erneut verarbeiten" in the SPA, or the `{"tags": []}` PATCH in the Paperless quick reference below |
| Paperless AI fields + lifecycle tags (idempotent; part of `task setup`) | `bash scripts/bootstrap-paperless.sh` |
| Qdrant collection info | `curl -s http://localhost:6333/collections/aktenraum_chunks` (dashboard at `/dashboard`) |
| Expose on the tailnet / show mappings | `tailscale serve --bg --https=443 http://localhost:8080` / `tailscale serve status` |

### Start / stop (raw)

```bash
cd docker
docker compose up -d          # start all                 (task start)
docker compose down           # stop all (data preserved) (task stop)
docker compose up -d --build auto-tagger   # rebuild after code changes (task build)
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

**First-run flow (Phase 0.1, ADR-002).** All runtime secrets except `PAPERLESS_API_TOKEN` are auto-generated by `bash scripts/bootstrap-secrets.sh` — it copies `docker/.env.example` → `docker/.env` if absent, fills empty REQUIRED values with `openssl rand`, and prints the auto-generated admin/SPA passwords ONCE for the user to record. The script is idempotent: re-runs are safe no-ops once everything is populated, which is why the future desktop shell will call it on every launch as a safety net. `PAPERLESS_API_TOKEN` still has to be minted via the Paperless API after the paperless container starts (see `scripts/bootstrap-paperless.sh`).

| What                   | Where                                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paperless URL          | http://localhost:8000 (admin UI, only used for backend tasks)                                                                                                                                                                                                       |
| aktenraum URL          | http://localhost:8080 (SPA — primary user interface)                                                                                                                                                                                                                |
| Paperless admin        | `PAPERLESS_ADMIN_USER` / `PAPERLESS_ADMIN_PASSWORD` in `docker/.env`                                                                                                                                                                                                |
| aktenraum admin        | `BOOTSTRAP_USERNAME` / `BOOTSTRAP_PASSWORD` in `docker/.env` (seeded on first start; ignored once a user exists)                                                                                                                                       |
| aktenraum JWT signing  | `JWT_SECRET` in `docker/.env` (`openssl rand -base64 32`)                                                                                                                                                                                              |
| Paperless DB password  | `PAPERLESS_DBPASS` in `docker/.env`                                                                                                                                                                                                    |
| Paperless API token    | `PAPERLESS_API_TOKEN` in `docker/.env` (mint via `POST /api/token/` after first paperless boot — example below)                                                                                                                                          |
| Restic passphrase      | `RESTIC_PASSWORD` in `docker/.env`                                                                                                                                                                                                                            |
| Webhook secret         | `WEBHOOK_SECRET` in `docker/.env` (single entry — all services load the same file). Gates paperless's `post_consume` webhook, the auto-tagger's `/trigger/*` endpoints, the aktenraum-api `/api/settings/active-llm-model` + `/api/settings/active-auto-approve-rules` internal endpoints. |
| auto-tagger → api      | `AKTENRAUM_API_URL` in `docker/.env` (default `http://aktenraum-api:8002`). Used for type-specific extraction PATCH + the per-DocumentType auto-approve rule fetch.                                                                                       |
| LLM backend            | `LLM_BACKEND=ollama` or `anthropic` in `docker/.env` (shared by both auto-tagger and aktenraum-api)                                                                                                                                         |
| Ollama model           | **NOTE: `OLLAMA_MODEL` is only a fallback.** The live extraction/answer model is the literal model tag stored in `app_settings.llm_model` / `answer_llm_model` (picked in `/settings`), not this env var (see the Known-gotcha row). `OLLAMA_MODEL=qwen2.5:14b-instruct-q8_0` (~16 GB) is used only when the api is unreachable. Smaller models (≤8B) reliably drop schema fields — the synthesizer fallbacks catch them but the output is less specific. Both `OLLAMA_MODEL` and `OLLAMA_ANSWER_MODEL` are in `docker/.env`. |
| Embedding model        | `EMBEDDING_MODEL=qwen3-embedding:4b` (2560-dim) in `docker/.env` — single entry, shared by both auto-tagger (indexing) and aktenraum-api (query). Pull with `ollama pull qwen3-embedding:4b`. Dimension is pinned in `@aktenraum/core rag.DENSE_DIM`; changing the model to a different dim requires `task rag:reembed`. (Migrated off bge-m3/1024 on 2026-06-22.) |
| AI search → Paperless  | `PAPERLESS_API_TOKEN` in `docker/.env` — shared token used by both auto-tagger and aktenraum-api; required for `/api/ai/*`                                                                                                                                                     |
| AI search → LLM        | `ANTHROPIC_API_KEY` (when `LLM_BACKEND=anthropic`) or `OLLAMA_BASE_URL` + `OLLAMA_MODEL` (when `LLM_BACKEND=ollama`), all in `docker/.env`                                                                                                             |
| AI answer → bigger LLM | Optional `OLLAMA_ANSWER_MODEL` / `ANTHROPIC_ANSWER_MODEL` in `docker/.env` — overrides the model used by `/api/ai/answer` only; pair a fast small model for filter extraction with a smarter big one for prose answers (8B is too small to read citations reliably; 14B+ recommended) |

Env files are gitignored. Example: `docker/.env.example` (single unified file — all services load from `docker/.env`). The API token is **per-database** — a fresh `pgdata/` means re-minting.

---

## Paperless API quick reference

```bash
TOKEN="$(grep PAPERLESS_API_TOKEN docker/.env | cut -d= -f2)"
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

- **`?name=` is silently ignored on `/api/tags/`** — it returns the default first page regardless. Use `?name__iexact=<name>` for exact match. The client-side equality check stays as defence in depth (see `PaperlessClient` in `@aktenraum/core`).
- **Custom fields with `data_type=string` have a hard 128-char DB limit.** Anything longer 400s the entire PATCH. We truncate at the boundary in `@aktenraum/core` `paperless/normalisers.ts` (ellipsis at 128 chars). The complementary `data_type=longtext` (Paperless 2.x+) has no length cap; fields backed by it must NOT be truncated. Use `truncateForField(name, value)` at the boundary — it consults the `LONGTEXT_FIELDS` allowlist (currently `{"ai_summary_de"}`) and skips truncation for those. To add a new longtext field: extend `LONGTEXT_FIELDS`, add the matching `ensure_custom_field … "longtext"` line in `scripts/bootstrap-paperless.sh`, and run `scripts/migrate-ai-summary-to-longtext.sh` (rename for the new field) to migrate existing installs.
- **Custom fields with `data_type=monetary` require the format `<ISO_CODE><amount>`** (e.g., `EUR149.99`) — the German format `149,99 EUR` is rejected. We normalise via `normalizeMonetary` (handles symbols, German/Anglophone thousands separators).
- **Custom fields with `data_type=date` require strict YYYY-MM-DD.** German `DD.MM.YYYY`, slashes, month-year-only all rejected. We normalise via `normalizeDate`.
- **Paperless's content-OCR date detector cannot be disabled.** It runs in the consumer (`documents/consumer.py:430`) when the parser ships no PDF metadata date and grabs _any_ date from the OCR text. It commonly picks up birthdates from CVs / IDs. Workaround: rely on the AI's `ai_issue_date` being correct so propagation overrides it; for a known recurring bad date use `PAPERLESS_IGNORE_DATES` env var.
- **Custom fields data type cannot be changed after creation.** Plan field types up front; recreate to migrate.
- **OCR fragments numbers with spaces** ("28.02.24" → "2 8. 0 2.24"). The system prompt explicitly tells the LLM to recognise this; keep that rule when editing.

---

## Directory layout

```
/
├── package.json                 # pnpm workspace root
├── pnpm-workspace.yaml          # apps/* + services/* + packages/*
├── pnpm-lock.yaml               # workspace-wide lockfile
├── .nvmrc                       # Node 22
├── .github/
│   └── workflows/ci.yml         # pnpm install → pnpm -r lint/build/test
├── docker/
│   ├── docker-compose.yml       # full stack definition
│   ├── docker-compose.dev.yml   # dev overlay: bind-mount src + `tsx watch`
│   ├── docker-compose.e2e.yml   # THROWAWAY stack for worker e2e (project aktenraum-e2e)
│   ├── .env                     # gitignored — unified secrets + config for all services
│   ├── .env.example             # committed template
│   ├── backup/                  # backup service: Dockerfile, entrypoint.sh, crontab
│   ├── nginx/                   # Dockerfile (bakes the SPA) + nginx.conf
│   ├── paperless-scripts/       # post_consume.sh — paperless → auto-tagger webhook trigger
│   └── systemd/                 # systemd units for future Linux-native deploy
├── packages/
│   └── aktenraum-core/          # @aktenraum/core — shared TS library, ESM
│       └── src/
│           ├── llm/             # AnthropicBackend, OllamaBackend, base interface, factory
│           ├── paperless/       # client.ts (PaperlessClient + LIFECYCLE_TAGS), normalisers.ts
│           ├── models/          # DocumentExtraction, DocumentType (27), typeSchema.ts
│           ├── rag/             # chunker, embedder, vectorStore, reranker
│           ├── dedup.ts         # field-based duplicate detector (shared by worker + api)
│           └── log.ts           # structured JSON events
├── services/
│   ├── aktenraum-api/           # @aktenraum/api — NestJS (ESM), port 8002
│   │   ├── src/
│   │   │   ├── main.ts          # applySchema → NestFactory → middleware → listen
│   │   │   ├── db/              # drizzle schema.ts + runnable schema.sql + applySchema
│   │   │   ├── paperless/       # PaperlessGateway + typed errors
│   │   │   ├── common/          # CSRF + security headers + {detail} error filter
│   │   │   ├── ai/ inbox/ library/ documents/ trash/ settings/ auth/ upload/ type-fields/
│   │   │   ├── eval/            # RAG eval runner + metrics
│   │   │   └── test/            # pg-mem harness + stateful fake Paperless
│   │   └── Dockerfile           # node:22-slim, non-root (build context = repo root)
│   └── auto-tagger/             # @aktenraum/worker — 5 concurrent loops, port 8001
│       ├── src/
│       │   ├── config.ts        # zod-validated env
│       │   ├── prompt.ts        # German SYSTEM_PROMPT + few-shot + history hint
│       │   ├── extract.ts       # LLM call, fallbacks, lifecycle tagging
│       │   ├── routing.ts       # confidence/auto-approve routing matrix
│       │   ├── propagate.ts     # ai-approved → native fields + dedup
│       │   ├── type-fields.ts   # second LLM pass: type-specific fields → api
│       │   ├── indexer.ts       # chunk → embed → upsert into Qdrant (+ metadata-only refresh, startup reconcile)
│       │   ├── backfill.ts      # one-shot RAG backfill CLI
│       │   ├── webhook.ts       # secret-gated listener for post_consume
│       │   └── loops.ts/main.ts # orchestration + graceful shutdown
│       └── Dockerfile           # node:22-slim, non-root
├── apps/
│   └── web/                     # @aktenraum/web — Nuxt 4 SPA (ssr: false, `nuxt generate`), Vue 3, Vue Query, Tailwind v4
│       ├── nuxt.config.ts       # SPA mode, Tailwind vite plugin, `/api` devProxy, prerender only `/`
│       ├── modules/             # external-inline-scripts.ts (keeps the generated index.html CSP-clean)
│       ├── tests/               # nuxt/ (mountSuspended) + unit/ (pure helpers)
│       └── app/
│           ├── pages/           # file-based routes: index, login, ask, upload, trash, settings, health, library/, inbox/, [...slug]
│           ├── layouts/         # default (with nav), bare (login, health)
│           ├── components/      # AppNav, ProcessingBadge, DocumentFieldsForm, library/, settings/
│           ├── composables/     # useApi + one composable per area (useLibrary, useInbox, useAnswerStream, useLiveCounts, …)
│           ├── middleware/      # auth, guest (named route middleware)
│           ├── plugins/         # vue-query.client.ts, live-counts.client.ts
│           └── utils/           # pure, auto-imported helpers (errors, sse, lifecycle-tags, …)
├── docs/
│   ├── adr/                     # Architecture Decision Records
│   ├── plans/                   # multi-phase roadmaps
│   ├── sessions/                # per-session summaries (binding cadence)
│   └── runbooks/                # first-time-setup, operations, restore, rotate-keys
├── scripts/
│   ├── setup.sh                 # create ~/aktenraum/ dirs
│   ├── bootstrap-secrets.sh     # generate every secret except the Paperless token
│   ├── bootstrap-paperless.sh   # create AI custom fields + tags via API (bash + curl)
│   ├── e2e-worker.sh            # end-to-end worker test against the throwaway stack
│   ├── backfill-rag-index.sh    # wrapper → `node dist/backfill.js` in the worker
│   ├── run-rag-eval.sh          # wrapper → `node dist/eval/runner.js` in the api
│   └── backup.sh                # host-side manual backup (mirrors container logic)
└── openspec/
    └── changes/                 # active + archived change proposals
```

---

## Auto-tagger behaviour

The service runs five concurrent loops from `loops.ts`, orchestrated by `main.ts`, sharing `AsyncQueue` instances for extraction and propagation (doc ids) and indexing (`IndexJob` = `{kind: "full" | "metadata", docId}`):

```
                        Paperless's post_consume_script
                                      ↓
                          POST /trigger/extract
                                      ↓
   poller ─────────► AsyncQueue<number> ◄────── webhook handler
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
| `ai-auto-approved`     | Auxiliary flag (not a lifecycle state); set alongside `ai-approved` when both gates pass (rule.enabled=true AND confidence ≥ rule.min_confidence for the doc's type, per the `auto_approve_rules` table). The SPA renders an "Auto-genehmigt" badge from this tag. Persists through propagation. |
| `ai-low-confidence`    | Auxiliary flag (not a lifecycle state); coexists with `ai-pending` to surface uncertain extractions in the review queue |

The auto-tagger's poller excludes the six lifecycle tags from its scan; the worker re-checks on dequeue and skips with `skip_already_processed` if any lifecycle tag is set (handles webhook+poller race).

### Extraction (worker + poller + webhook)

- **Webhook** (`POST /trigger/extract`, port 8001 internal-only): paperless's `post_consume_script` POSTs the doc id; auto-tagger enqueues. Optional `X-Aktenraum-Secret` header — when `WEBHOOK_SECRET` is set, must match.
- **Poller** (`POLL_INTERVAL_SECONDS`, default 30s): scans for docs without lifecycle tags and enqueues. Safety net for missed webhooks.
- **Worker**: drains queue. Per-doc steps:
  1. Re-fetch by id; skip if any lifecycle tag (race protection)
  2. Build prompt: base SYSTEM_PROMPT + (optional) per-correspondent history hint + (optional) few-shot exemplars from propagated corpus
  3. Call configured LLM backend; validate via zod
  4. PATCH 12 `ai_*` custom fields (with monetary, date, string normalisers at boundary)
  5. Apply lifecycle tag(s) per routing rules (single PATCH)
  6. Non-`Sonstiges` docs: second LLM pass extracts the type's `TYPE_FIELD_SCHEMA` fields and PATCHes the non-empty ones to `/api/documents/{id}/type-fields` (`auto-tagger/src/type-fields.ts`, non-fatal: `type_specific_pass_done` / `_failed`). Dropped in the Node port and restored 2026-10-01 — docs extracted between the cutover and then have no type fields until reprocessed.

### Confidence-based routing (`routing.routeLifecycleTags`)

Per-`DocumentType` rules live in the aktenraum-api `auto_approve_rules` table (one row per enum value, 27 total), edited from `/settings → Auto-Genehmigung` in the SPA. The auto-tagger fetches them over HTTP (`GET /api/settings/active-auto-approve-rules`, secret-gated via `WEBHOOK_SECRET`) with a 60-second in-process TTL cache (`auto-tagger/src/auto-approve-config.ts`).

| Condition                                                                        | Tag(s) applied                                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `rule.enabled` AND `confidence ≥ rule.min_confidence` for the doc's type         | `["ai-approved", "ai-auto-approved"]` (skips review; propagation fires)   |
| `rule.enabled = false` for the doc's type                                        | `["ai-pending"]` with `reason="type_disabled"`                            |
| `rule.enabled` AND `confidence < rule.min_confidence`                            | `["ai-pending"]` with `reason="confidence_below_min"`                     |
| Rule store unreachable at cold start (api down before auto-tagger boot)          | `["ai-pending"]` with `reason="rules_unreachable_fail_closed"`            |
| Additionally if `confidence < LOW_CONFIDENCE_THRESHOLD` (and not auto-approving) | appends `ai-low-confidence` to whichever pending branch above             |

The legacy `AUTO_APPROVE_TYPES` + `AUTO_APPROVE_CONFIDENCE` env vars are not read by any code. New rows are seeded by the api (`schema.sql` default + the startup reconciler) with `enabled=false`, `min_confidence=0.90` for all 27 types; the table is the only source of truth. Fail-closed semantics: when the api is unreachable AND no cache is populated yet, no document auto-approves — the operator's intent re-loads when the api is back.

### Corpus-driven learning (no model retraining)

- **Few-shot exemplars** (`FEW_SHOT_EXAMPLES`, default 0): each extraction prepends N most-recently-propagated docs as `(text excerpt, expected JSON)` pairs in the system prompt. Reads native fields (post-propagation ground truth) with fallback to `ai_*` custom fields.
- **Per-correspondent history hint** (`USE_CORRESPONDENT_HISTORY`, default true): builds `{sender: {document_type: count}}` from the `ai-propagated` corpus. If the document text mentions a known sender (longest substring match in first 1000 chars), prepends a German hint naming the dominant past type (≥70% of ≥2 prior docs) or the full distribution.

Together these turn user corrections into future signal: edit the AI fields pre-approval, OR rename a Correspondent post-propagation, and the next extraction sees the corrected version.

### Propagation (`propagate.processApprovedDocument`)

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

Switch by editing `docker/.env` and running `docker compose up -d auto-tagger aktenraum-api` (restart alone does NOT re-read env files — must use `up -d`). After source changes also use `--build`.

### Document taxonomy (27 types)

Rechnung · Gehaltsabrechnung · Kontoauszug · Nebenkostenabrechnung · Hausgeldabrechnung · Mahnung · Vertrag · Kündigung · Versicherung · Steuer · Lohnsteuerbescheinigung · Spendenbescheinigung · Bescheid · Behördenbrief · Sozialversicherungsmeldung · Kfz · Bußgeldbescheid · Arztbrief · Krankschreibung · Garantie · Urkunde · Ausweis · Zeugnis · Arbeitszeugnis · Mitgliedschaft · Beleg · Sonstiges

Defined in `packages/aktenraum-core/src/models/extraction.ts` `DocumentType`. Prompt definitions in `services/auto-tagger/src/prompt.ts` `SYSTEM_PROMPT` (with explicit disambiguation rules — read before editing; its exact length is pinned by a test so an accidental edit fails CI). Per-type extraction fields in `packages/aktenraum-core/src/models/typeSchema.ts` `TYPE_FIELD_SCHEMA`, typed as `Record<DocumentType, …>` so a missing type is a compile error.

**Gotchas — disambiguation rules baked into SYSTEM_PROMPT**:

- **Meldebescheinigung** has two flavours: the employer's annual "Meldebescheinigung zur Sozialversicherung" (DEÜV §25) → `Sozialversicherungsmeldung`; the Bürgeramt-issued address confirmation → `Behördenbrief`.
- **Lohnsteuerbescheinigung vs. Steuer**: the employer's annual §41b EStG certificate is its own type — keep it out of `Steuer`. `Steuer` is for Steuererklärungen / Anlagen; `Steuerbescheid` (Finanzamt-issued) goes to `Bescheid`.
- **Hausgeldabrechnung vs. Nebenkostenabrechnung**: WEG-Eigentümer get a `Hausgeldabrechnung` from the Hausverwaltung; tenants get a `Nebenkostenabrechnung` from the landlord. Wohngeldbescheid (housing benefit) is a `Bescheid`.
- **Bußgeldbescheid vs. Bescheid**: traffic fines split off into their own type — `Bescheid` is reserved for non-traffic admin acts.
- **Krankschreibung vs. Arztbrief**: short AU-Bescheinigung ("gelber Schein") is `Krankschreibung`; longer medical reports / findings stay in `Arztbrief`.
- **Spendenbescheinigung**: Zuwendungsbestätigung under §50 EStDV — distinct from `Rechnung`, `Mitgliedschaft`, or the user's own `Steuer` filing.

---

## Validation patterns at the LLM/Paperless boundary

Local LLMs (especially small ones like gemma4 8B) emit data the Paperless API rejects on edge cases. We layer two defences: schema-level coercion at the zod boundary, and value normalisation at the PATCH boundary.

| Issue                                                                           | Where                                                             | Fix                                                                                           |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| LLM returns `null` for a list field instead of `[]`                             | `CoercedListSchema` (`models/extraction.ts`, `z.preprocess`)       | Coerces None → []                                                                             |
| LLM returns int in a list of strings (e.g. `[42, "text"]`)                      | `CoercedStrSchema` (`models/extraction.ts`, `z.preprocess`)        | Coerces to str                                                                                |
| LLM emits monetary as German `"149,99 EUR"`; Paperless wants `"EUR149.99"`      | `normalizeMonetary` (`paperless/normalisers.ts`)                  | Regex parse + ISO-format reformat                                                             |
| LLM emits date as `"01.12.2024"` or `"12-2024"`; Paperless wants `"YYYY-MM-DD"` | `normalizeDate` (`paperless/normalisers.ts`)                      | strptime against a list of common formats                                                     |
| LLM emits a string longer than Paperless's 128-char custom-field limit          | `truncateForField` (`paperless/normalisers.ts`)                   | Truncates `string` fields; passes `longtext` fields (e.g. `ai_summary_de`) through unmodified |
| LLM suggests a lifecycle tag (`ai-approved`) as a real tag                      | `splitSuggestedTags` (`auto-tagger/src/propagate.ts`)             | Filter out lifecycle names                                                                    |
| LLM suggests a tag truncated by the 128-char limit (ends with `…`)              | `splitSuggestedTags` (`auto-tagger/src/propagate.ts`)             | Drop fragments ending in ellipsis                                                             |
| Paperless 4xx hides the validation reason                                       | `PaperlessClient.patchDocumentNativeFields` + `getOrCreateNamed`  | Log response body via `paperless_patch_rejected` / `paperless_create_rejected` events         |

---

## Backup

- **Container**: `backup` service, crond fires `entrypoint.sh` daily at 02:00
- **What**: `~/aktenraum/data`, `media`, `export` + **two** live postgres dumps — `paperless` (`postgres.dump`, tag `postgres`) AND `aktenraum` (`aktenraum.dump`, tag `postgres-aktenraum`; SPA users + auto-approve rules). Both stdin-piped, no temp file.
- **Retention**: 7 daily, 4 weekly, 12 monthly
- **Repo**: `~/aktenraum/backup/restic-repo/` (mounted at `/repo` in container)
- **Manual run**: `docker compose --project-directory docker exec backup /usr/local/bin/entrypoint.sh` (Git Bash: `MSYS_NO_PATHCONV=1` and `//usr/local/bin/entrypoint.sh`)
- **List snapshots**: `docker compose --project-directory docker exec -e RESTIC_REPOSITORY=/repo backup restic snapshots --tag aktenraum`
- **Integrity check**: `docker compose --project-directory docker exec -e RESTIC_REPOSITORY=/repo backup restic check --read-data-subset=5%` (also runs weekly inside the entrypoint on Sundays, and as part of `task backup:verify`)
- **DR rehearsal (non-destructive)**: `task backup:verify` — `restic check` + filesystem restore to a staging dir + validates both DB dumps are present and look like pg_dumps. Run this to actually trust the backup.
- **Restore**: see [`docs/runbooks/restore.md`](docs/runbooks/restore.md) (filesystem `/backup/*` paths + both databases)
- **Auto-init**: the entrypoint does NOT silently create a missing repo — it fails loudly unless `BACKUP_AUTO_INIT=true`. First-time init is done by `task setup`.

---

## Development workflow (OpenSpec)

All non-trivial changes go through OpenSpec before implementation:

```bash
openspec new change "<name>"          # scaffold proposal/design/specs/tasks
openspec status --change "<name>"     # check artifact progress
openspec instructions <id> --change "<name>"  # get writing instructions per artifact
```

Artifacts: `proposal.md` → `design.md` + `specs/` → `tasks.md` → implement.
Completed changes: `aktenraum-foundation`, `backup-timer`, `extract-aktenraum-core`, `rewrite-stack-nodejs-angular`, `migrate-web-to-nuxt` (learning-motivated Angular → Nuxt 4 port, see [ADR-008](docs/adr/008-nuxt-vue-frontend.md); last Angular commit tagged `web-angular-final`).

**Distribution direction (binding)**: aktenraum is being built for sale as a Tauri desktop app wrapping the Docker Compose stack — not as a Docker tarball. See `docs/adr/002-distribution-desktop-app.md` for the constraints this places on every change (no committed secrets, configurable data dir, idempotent first-run, model auto-pull, etc.) and `docs/plans/desktop-app.md` for the phased roadmap. **Phase 0 — self-bootstrapping compose — is the unblocker; nothing Tauri-specific lands until Phase 0 is done.** **Currently deferred per [ADR-005](docs/adr/005-test-phase-access-via-tailscale.md): during the testing phase the maintainer validates the product via Tailscale-mediated remote access (`docs/runbooks/tailscale-remote-access.md`); Phase 0 resumes when the milestones listed in ADR-005 are met.**

**RAG direction (binding)**: the answer pipeline is being upgraded to production-grade local retrieval — Qdrant + Qwen3-Embedding-4B (dense, 2560-dim; migrated off bge-m3 2026-06-22) + bge-reranker-v2-m3 (transformers.js, in-process), with Ollama for embeddings; sparse/hybrid retrieval is planned but not built. See `docs/plans/rag-phase-1.md` for the architecture, schema, sub-phasing (1.1–1.12), and the eval harness that gates merges. `/api/ai/answer/stream` combines AI metadata with reranked chunks of the full OCR text, so questions whose answers live in the document body (CV employment durations, contract clauses, etc.) work.

**Documentation cadence (binding)**: every working session ends with a session summary at `docs/sessions/YYYY-MM-DD.md` listing what shipped, by feature, with commit hashes; a "things to pick up next session" block; and the active roadmap progress for any plan in `docs/plans/`. Architectural decisions go to `docs/adr/NNN-name.md` (template at `docs/adr/000-template.md`). Multi-phase initiatives go to `docs/plans/<topic>.md`. Whenever a session changes any of these (new feature, new gotcha, new constraint, finished phase), CLAUDE.md is updated in the same commit so future sessions see current state without trawling git log.

Use `/openspec-propose` skill to create a full change in one step.
Use `/opsx:apply` skill to implement tasks from an approved change.

---

## Known gotchas

| Issue                                                                                                       | Fix                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`AKTENRAUM_DATA_DIR` unset on Windows causes silent data loss** — `${HOME}` resolves differently from Git Bash vs PowerShell vs Task runner, so each `docker compose up` may write postgres to a new path and initialise a fresh empty DB, abandoning the old data (two incidents: May 20, May 23 2026) | Set `AKTENRAUM_DATA_DIR=D:/aktenraum` (or your chosen Windows path) in `docker/.env`. The `.env.example` now has this line uncommented with a warning. Never change it without migrating the data directory first. |
| Restic backup repo must exist before any snapshot. `task setup` performs the one-time `restic init`. The `backup` container's `entrypoint.sh` does **NOT** silently auto-init — it fails loudly when the repo is missing (set `BACKUP_AUTO_INIT=true` only for a deliberate new repo), so a drifted `AKTENRAUM_DATA_DIR` can't silently start a fresh empty backup history | First-time init: `task setup`. Verify recoverability with `task backup:verify` (non-destructive DR rehearsal) and integrity with `restic check` (see the Backup section). (NB: the historical "empty repo / silent no-op" was actually the cron-format bug in `docker/backup/crontab` — a `root` user-column that BusyBox crond couldn't run — fixed 2026-05-28, not a missing `restic init`.) |
| `docker compose restart` doesn't re-read env files                                                          | Use `docker compose up -d` to recreate the container                                                                                                                                            |
| Source changes don't take effect on restart                                                                 | `docker compose up -d --build auto-tagger` (or `task build`) to rebuild                                                                                                                         |
| Git Bash converts `/usr/local/bin/...` to Windows path in `docker exec`                                     | Prefix with `MSYS_NO_PATHCONV=1` and use `//usr/local/bin/...`                                                                                                                                  |
| Paperless `?name=` filter is silently ignored on `/api/tags/` (returns first page regardless)               | Use `?name__iexact=<name>`; keep the client-side equality re-check as defence in depth                                                                                                          |
| Paperless `data_type=string` custom fields have a hard 128-char limit                                       | Use `truncateForField` at the boundary; ellipsis on overflow. Use `data_type=longtext` (Paperless 2.x+) for fields that need more — extend the `LONGTEXT_FIELDS` set so truncation is skipped |
| Paperless `data_type=monetary` requires `<ISO><amount>` format                                              | Use `normalizeMonetary`                                                                                                                                                                         |
| Paperless `data_type=date` requires strict YYYY-MM-DD                                                       | Use `normalizeDate`                                                                                                                                                                             |
| Paperless's content-OCR date detector cannot be turned off via env var                                      | Rely on AI extracting `ai_issue_date` correctly so propagation overrides; or use `PAPERLESS_IGNORE_DATES` for known recurring bad dates                                                         |
| OCR fragments numbers ("28.02.24" → "2 8. 0 2.24")                                                          | `SYSTEM_PROMPT` explicitly tells the LLM to recognise this pattern; keep the rule when editing                                                                                                  |
| `ghcr.io/paperless-ngx/tika` requires auth                                                                  | Use `apache/tika` instead                                                                                                                                                                       |
| `python` vs `python3` differs across platforms (Git Bash has `python`, macOS has `python3`)                 | Scripts auto-detect with `command -v python3 \|\| command -v python`                                                                                                                            |
| Ollama model may return `---\n{...}` (YAML prefix) or integers in tag lists or `null` for empty list fields | Handled in `cleanJson` (`llm/ollamaBackend.ts`), `CoercedStrSchema`, `CoercedListSchema`                                                                                                        |
| Restic `--last` flag is deprecated                                                                          | Use `--latest <N>`                                                                                                                                                                              |
| Webhook + poller race-enqueue the same doc                                                                  | Worker re-checks lifecycle tags on dequeue, logs `skip_already_processed` if already processed                                                                                                  |
| Same content uploaded twice                                                                                 | Paperless dedups by SHA1 — duplicate is silently dropped, no double-processing                                                                                                                  |
| **CSRF middleware blocks browser requests with `Sec-Fetch-Site: cross-site`** on state-changing methods + `/preview` + `/download` | Internal callers (auto-tagger webhook, paperless `post_consume`) bypass by including `X-Aktenraum-Secret`. See ADR-003. Tauri WebView will need the same header or a same-origin proxy. |
| `PaperlessClient` entity caches (tag id, custom field id, name maps) are TTL'd 5 min by default            | After out-of-band Paperless changes (`scripts/bootstrap-paperless.sh`, manual delete), call `client.invalidateCaches()` or wait one TTL; the gateway also auto-refreshes on unknown-field warnings |
| Auto-approve rule changes take up to 60s to take effect in the auto-tagger                                  | The auto-tagger fetches the rule set with a 60-second in-process TTL cache (`auto-approve-config.ts`). Saves in `/settings → Auto-Genehmigung` land in Postgres immediately but the next routing decision can use a cached older snapshot. On a SAVE-then-upload-immediately workflow this can mean the first doc still routes under the old rules. Workaround: wait one minute, or restart `auto-tagger` to force a cold fetch. Failures: rule store unreachable + populated cache → reuse cache + WARN; rule store unreachable + cold start → fail-closed (every doc → pending) until the next successful fetch. |
| `COOKIE_SECURE` defaults to `True`                                                                          | Localhost dev sets `COOKIE_SECURE=false` in `docker/.env` to allow login over plain http://localhost:8080; production HTTPS deploys leave it unset                                  |
| Login appears to succeed but every API call returns 401 — auth cookie set, never sent                       | Cause is `COOKIE_SECURE=true` (the default) combined with plain-HTTP access (typically `http://<lan-ip>:8080` from a non-host device). The browser refuses to send a `Secure` cookie over plain HTTP, so login looks like it works then bounces indefinitely. Fix: use the Tailscale MagicDNS HTTPS URL (`https://<host>.<tailnet>.ts.net/`) instead. Do NOT flip `COOKIE_SECURE=false` to "fix" this — that weakens security for no reason. See `docs/runbooks/tailscale-remote-access.md` failure-mode appendix. |
| `swapLifecycleTag` can raise `PaperlessConflictError` (HTTP 409) under heavy concurrency                  | Three-attempt verify-and-retry built in; if the third attempt still races, the SPA surfaces a "refresh and try again" message                                                                   |
| nginx `client_max_body_size 500m` caps total multipart upload size                                          | Per-file limit (`UPLOAD_MAX_FILE_BYTES`, 25 MB default) and file-count limit (`UPLOAD_MAX_FILES_PER_REQUEST`, 20) enforced server-side; MIME content-type allowlist rejects unknown formats     |
| Small LLMs (≤8B) drop `summary_de`, `reference_numbers`, `suggested_tags` despite the prompt rule           | Tagger has post-extraction fallbacks in `auto-tagger/src/synthesizers.ts`: `synthesizeSummaryDe` (deterministic German summary from struct fields) + `extractReferenceNumbersFromText` (regex sweep over OCR for Aktenzeichen/Rechnungsnr./Vertragsnr./Kundennr./Vorgangsnr./Bestellnr./Auftragsnr./Policennr./Steuernr.). Logs `summary_de_synthesized` / `reference_numbers_harvested` when they fire. `suggested_tags` has no synthesis fallback — risk of fabricating useless tags is higher than benefit |
| Approve action feels laggy (up to 30s before propagation)                                                   | The `POST /api/inbox/{id}/approve` handler fires a best-effort `POST /trigger/propagate` against auto-tagger (`AUTO_TAGGER_URL`, default `http://auto-tagger:8001`). Both services now load the same `docker/.env` so `WEBHOOK_SECRET` is always consistent. If the trigger returns 401, verify the containers were recreated after the last `.env` edit (`task build` or `docker compose up -d`). Symptom: approve returns 200 but the doc takes up to 30s to flip from `ai-approved` → `ai-propagated`.                                                                                                                                                                                                                                                |
| **`DELETE /api/documents/{id}/` is a soft-delete, not hard-delete** — Paperless 2.x always moves to `/api/trash/` | The previous `PaperlessGateway.deleteDocument` docstring claimed "no soft-delete", which was wrong. Hard-delete only happens via `POST /api/trash/` with `action: "empty"` — the trash service does that AND `vectorStore.deleteByDocId` on the SPA's "Endgültig löschen" / "Papierkorb leeren" paths. Without an empty step, soft-deleted docs auto-purge after `PAPERLESS_EMPTY_TRASH_DELAY` days (default 30). Note: a soft-deleted doc's Qdrant chunks remain in the index until the empty step runs — RAG retrieval can still surface "trashed" content until the user actually empties. Real fix is a follow-up (query-time exclusion or a chunk-payload `trashed` flag). |
| Auto-approve doesn't fire on a Rechnung you expected to skip review                                          | `docker compose logs auto-tagger \| grep routing_decision` and read the `reason=…` field on the matching `doc_id` line. Closed-enum values: `auto_approved` (both gates passed), `type_disabled` (rule.enabled=false for that type — flip the checkbox in `/settings → Auto-Genehmigung`), `confidence_below_min` (LLM gave the doc a low score relative to the per-type threshold — inspect `ai_confidence` + `ai_confidence_reason` in the inbox detail to see why, or lower the per-type Min. Konfidenz), `rules_unreachable_fail_closed` (aktenraum-api was unreachable at the auto-tagger's cold start — wait 60s or restart). Routing logic itself is correct and tested; the reason field tells you which gate blocked the doc. |
| Duplicate dismissal is sticky via `ai-duplicate-dismissed`                                                   | Clicking "Kein Duplikat" on a doc adds the `ai-duplicate-dismissed` aux tag in addition to removing `ai-duplicate`. The propagator's dedup helper (`findDuplicateIds` in `auto-tagger/src/propagate.ts`) short-circuits if the NEW doc carries the dismissed tag and filters out candidates carrying it from the comparison set — so a re-propagation against the same correspondent cluster doesn't re-flag the user's prior decision. To un-dismiss (re-enable detection on a doc), remove `ai-duplicate-dismissed` manually in Paperless's tag UI; the next propagation will treat it like a fresh doc again. |
| Qdrant tag payload only refreshes on star/unstar — NOT on `ai_suggested_tags` edits          | The RAG indexer (`indexDocument` in `auto-tagger/src/indexer.ts`) writes a doc's Qdrant payload (`tags`, `correspondent`, `doc_type`, `created_date`) exactly once, at first propagation. Editing "Vorgeschlagene Tags" on an already-`ai-propagated` doc in the Library review page only PATCHes the `ai_suggested_tags` custom field — it never touches Paperless's native `tags`, so it was never going to reach Qdrant either way; use "Erneut verarbeiten" if you want that edit to become real. The one native-tag-changing action that *is* kept fresh: starring/unstarring (`wichtig`) fires a best-effort `POST /trigger/reindex-metadata` (auto-tagger, mirrors `/trigger/propagate`) that refreshes just the Qdrant payload metadata via `QdrantVectorStore.updateMetadataByDocId` — no re-chunk, no re-embed. If a future feature adds a general native-tag editor to the Library page, wire it to the same trigger rather than reinventing it. |
| **The live LLM model is the DB setting, NOT `OLLAMA_MODEL`** — setting `OLLAMA_MODEL` while the api is up does nothing | `app_settings.llm_model` / `answer_llm_model` hold literal Ollama tags, edited in `/settings` (dropdown of pulled models, text input when Ollama is unreachable). The api reads them directly; the auto-tagger fetches `GET /api/settings/active-llm-model` (secret-gated) through `auto-tagger/src/active-model.ts` with a 60 s cache, reusing the last good value on a blip and falling back to `OLLAMA_MODEL` only on a cold failure (`active_llm_model_unreachable_using_env`). The Node worker skipped this lookup until 2026-10-01 (`harden-worker-pipeline`). Symptom of a bad value: `LLM-Extraktion fehlgeschlagen – model '<name>' not found (404)` → `ollama pull` it or pick another model in `/settings`. |
| **transformers.js caches models inside `node_modules`, not `HF_HOME`** — the Node reranker re-downloads ~545 MB on every image rebuild and can leave a truncated file | `@huggingface/transformers` ignores `HF_HOME`/`HUGGINGFACE_HUB_CACHE` unless `env.cacheDir` is set explicitly. Unset, the ONNX model lands in an image layer: it re-downloads on every `docker compose build`, and a rebuild that interrupts a download leaves a partial file that fails at load with `Protobuf parsing failed` / `ModelProto does not have a graph` — which reads like a corrupt model, not a caching bug. `packages/aktenraum-core/src/rag/reranker.ts` sets `env.cacheDir` from `TRANSFORMERS_CACHE`/`HUGGINGFACE_HUB_CACHE`/`HF_HOME`. Related: a short-lived process (e.g. the eval runner) can start the download and exit before it finishes, poisoning the cache — let the long-running API finish its prewarm first. |
| **Changing the embedding model/dimension requires a full re-index** — `ensure_collection()` only CREATES when missing, so it keeps a stale-dim Qdrant collection and new upserts/queries fail silently | Run `task rag:reembed`: it drops the `aktenraum_chunks` collection (from inside the auto-tagger container, no host curl) and runs `backfill --force`, which recreates it at the current `@aktenraum/core rag.DENSE_DIM` and re-embeds every document. Paperless docs are untouched — only the vector index is rebuilt; RAG/Ask is degraded until the backfill finishes. Also pull the new model first (`ollama pull <model>`) and set `EMBEDDING_MODEL` in `docker/.env`. |
| **Worker LLM calls are bounded and retried** | Structured Ollama calls time out after `LLM_TIMEOUT_SECONDS` (default 300) and request `num_ctx=OLLAMA_NUM_CTX` (default 24576 — Ollama's server default of 4–8k silently truncates the ~14k-char system prompt plus document text). A transient failure (connection refused, timeout, 429/5xx) leaves the document untagged and logs `extraction_deferred`; the 30 s poller retries it, and the third transient failure tags `ai-error`. The counter is in-memory and resets on restart. Streaming (`/ask`) has no timeout. |
| **RAG indexing safety** | The indexer embeds before deleting old chunks, so an Ollama outage during re-index never removes a document from search. `reindex-metadata` (star/unstar) only rewrites the Qdrant payload when chunks exist. The indexing queue is in-memory, so on every start the worker enqueues each `ai-propagated` document with zero chunks (`index_reconcile_completed`). Propagation skips any document that no longer carries `ai-approved` (`skip_not_approved`). |
| **The reranker must batch** — scoring all 50 candidates in one pass OOM-kills the api (exit 137, no log line) | `LocalReranker.rerank` scores in batches of `RERANK_BATCH_SIZE` (8) with `max_length` `RERANK_MAX_TOKENS` (512). Unbatched, bge-reranker-v2-m3 padded 50 pairs to the longest and blew past the 4 GB `AKTENRAUM_API_MEM_LIMIT` the moment an unfiltered RAG query returned many chunks — the container silently restarted mid-stream. Symptom: `/ask` returns only the `meta` event and `docker events --filter event=die` shows exit 137. Peak is now ~1.7 GB. |
| **nginx sends no security headers on the SPA document** | `location = /index.html` has its own `add_header Cache-Control`, and nginx drops every inherited server-level `add_header` in a location that declares any. So `index.html` ships without CSP, `X-Frame-Options`, `nosniff` or `Referrer-Policy` — for the SPA. Found 2026-09-29, not yet fixed: repeat the security headers inside that location (or move them to an `include` snippet). |
| **Nuxt's generated `index.html` breaks `script-src 'self'`** | `nuxt generate` emits an inline import map and an inline `window.__NUXT__` config script; Nuxt's built-in error pages inject a modulepreload polyfill via `useHead`. Fixes in `apps/web`: `experimental.entryImportMap: false`, `modules/external-inline-scripts.ts` (moves inline scripts into hashed `/_nuxt/boot.*.js` at prerender time) and a custom `app/error.vue`. Also: only `/` is prerendered (`prerender:routes` hook) — per-route `index.html` folders make nginx 301 `/login` → `/login/` and drop the port. |
| **The Node API creates its own schema; `0000_certain_guardian.sql` does NOT** | That file is drizzle-kit *introspection* output with its whole body commented out — a drift oracle, not a runnable migration. The runnable copy is `services/aktenraum-api/src/db/schema.sql`, applied transactionally by `applySchema()` before `NestFactory.create`. Symptom when it is missing or unshipped: `api_start_failed … Failed query: select "id" from "users"` at boot on a fresh database. `tsc` does not copy `.sql`, so the Dockerfile must copy it into `dist/db/` — if you add a table, add it to `schema.ts` AND `schema.sql` (`apply-schema.test.ts` fails otherwise). The file also seeds `alembic_version='0006'` when empty — a leftover from the Python rollback window that nothing reads any more; safe to drop together with its test in `apply-schema.test.ts`. |

---

## What's implemented vs planned

| Feature                                                                                         | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paperless-ngx deployment                                                                        | ✅ Running                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Auto-tagger (Ollama + Anthropic)                                                                | ✅ Running                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 27-type German document taxonomy                                                                | ✅ Live                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Daily backup (Docker crond + restic)                                                            | ✅ Running                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Propagation watcher (ai-approved → native fields)                                               | ✅ Running                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Confidence-based routing (auto-approve allowlist)                                               | ✅ Running                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Auto-Genehmigung settings (per-type, edited in SPA)                                             | ✅ Per-`DocumentType` `enabled` + `min_confidence` rules in Postgres, edited from `/settings → Auto-Genehmigung`, consumed by the auto-tagger over HTTP with a 60s TTL cache + fail-closed default. Replaces the legacy `AUTO_APPROVE_TYPES` / `AUTO_APPROVE_CONFIDENCE` env-var pair.                                                                                                                                                                                       |
| Few-shot exemplars from propagated corpus                                                       | ✅ Available (`FEW_SHOT_EXAMPLES > 0`)                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Per-correspondent history hint                                                                  | ✅ Default on                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Webhook trigger from paperless `post_consume_script`                                            | ✅ Running                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Test suite (vitest ×4) + eslint + GitHub Actions CI                                              | ✅ Running (644 tests)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Nuxt SPA                                                                                        | ✅ Running (`apps/web`, Nuxt 4 SPA mode, statically generated and served by nginx on `:8080`; replaced the Angular SPA per [ADR-008](docs/adr/008-nuxt-vue-frontend.md))                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Find docs (`/api/ai/find` backend; SPA `/find` page removed)                                    | ⚠️ Backend-only — the `/api/ai/find` endpoint + closed-enum `SearchFilter` translator still exist and are tested, but the SPA `/find` page (and `FilterChips`) were removed 2026-06-01: structured AI search overlapped with Ask AI, so the nav folded down to one AI entry point. `/find` now 404s in the SPA; the Ask page's "weitere Treffer" footnote links to the Bibliothek instead. The backend route is currently unused by the frontend — keep it (cheap, tested) or retire in a later cleanup.                                                                                                                                                                                                          |
| Ask AI conversational Q&A (`/api/ai/answer` + `/ask`)                                           | ✅ Phase 2.5 — German prose answer with citations; small model for filter, big model for answer                                                                                                                                                                                                                                                                                                                                                                               |
| Document preview/download proxies (`/api/documents/{id}/{preview,download}`)                    | ✅ Reusable across Ask/Find/Inbox/Library; token never reaches the browser                                                                                                                                                                                                                                                                                                                                                                                                    |
| Inbox review queue (`/api/inbox/*` + `/inbox` + `/inbox/$id`)                                   | ✅ Phase 3 — two-pane PDF preview, editable AI fields, approve/reject, keyboard shortcuts                                                                                                                                                                                                                                                                                                                                                                                     |
| Library / Bibliothek (`/api/library/` + `/library`)                                             | ✅ Filterable list of all non-pending docs; URL-state filters; row click → `/library/$id` two-pane review (PDF + editable AI fields, Save / Reset / Reprocess / Download). **Sortierung** dropdown (6 options: `-created` default, `created`, `-modified`, `modified`, `title`, `-title`) persisted via `?ordering=…`. **In-flight pin**: on `page=1` the server fetches the auto-tagger's `/processing` slots (extraction + propagation + indexer) and prepends those docs as `is_processing=true` rows, de-duped against the natural sort — so a doc the worker is actively handling never gets buried by pagination. |
| Upload (`POST /api/documents/upload` + `/upload`)                                               | ✅ Drag-and-drop dropzone, single + multi-file, per-file progress + status, isolated failures; uploads stream through aktenraum-api so the Paperless token stays server-side                                                                                                                                                                                                                                                                                                  |
| Reprocess (`POST /api/documents/{id}/reprocess`)                                                | ✅ Clears all 7 lifecycle tags; pings auto-tagger webhook (with optional `WEBHOOK_SECRET`) for instant turnaround; falls back to the 30s poller. Reprocess button on the preview modal                                                                                                                                                                                                                                                                                        |
| Processing visibility (`/documents/in-flight`, `/task/{uuid}`, `/{id}/status`, ProcessingBadge) | ✅ DocumentSummary carries `lifecycle_tags`; shared SPA badge (Wartet auf KI / Wird übertragen / Verarbeitet / In Inbox / Fehler / etc.) renders on Library rows + Find/Ask cards; Upload page polls task → doc-status → lifecycle for live progress; Nav shows a global "N in Bearbeitung" pill, refetched every 30s                                                                                                                                                         |
| RAG retrieval (Qdrant + Qwen3-Embedding-4B + bge-reranker-v2-m3)                                | ✅ Phase 1 — chunker, embedder, vector store, indexer task in auto-tagger, backfill script, dense retrieval, reranker, eval harness all live (sparse/hybrid not built yet). (Embedder migrated bge-m3 → qwen3-embedding:4b, 2560-dim, 2026-06-22; `task rag:reembed` rebuilds the index after a model/dim change.) `/api/ai/answer/stream` serves chunk-grounded answers with `[Quelle: <id>]` citations. Opt-in via `QDRANT_URL` (set in compose by default; empty disables and falls back to AI-metadata-only path). 10/12 sub-phases done; 1.11 (model auto-pull) joins desktop-app 0.3, 1.12 (docs) ongoing. See `docs/plans/rag-phase-1.md`. |
| RAG eval harness                                                                                | ✅ Phase 1.10 — `bash scripts/run-rag-eval.sh` (`node dist/eval/runner.js` in the api container) reports recall@K + MRR over `evals/golden-questions.yaml`. JSON output for CI threshold gates.                                                                                                                                                                                                                                                                                      |
| Confidence-vs-correctness eval (`scripts/eval-confidence-correlation.py`)                       | ✅ Available — joins `ai_confidence` against an "approved-unedited" proxy (correspondent + doctype match) over the propagated corpus, emits CSV + Pearson. Initial run on n=19 shows confidence clustered at ~0.978 (zero variance) so Pearson is meaningless until the corpus diversifies. **Decision criterion**: re-evaluate auto-approve routing once N≥50 docs span all three buckets; if Pearson <~0.3 then per-type `min_confidence` is gating on noise and should be revisited (rules can still vary by type, just with different thresholds). Until then, the seeded defaults (every type disabled, `min_confidence=0.90`) keep auto-approve off until the operator opts in via `/settings → Auto-Genehmigung`. |
| Papierkorb / Trash (`/api/trash/*` + `/trash` page)                                             | ✅ Two-step delete model: Löschen on the library detail page (two-click confirm) moves the doc to Paperless's trash (recoverable for `PAPERLESS_EMPTY_TRASH_DELAY` days, default 30); `/trash` lists trashed docs with per-row Wiederherstellen / Endgültig löschen and a top-bar Papierkorb leeren modal. Endgültig löschen and Empty trash hard-delete in Paperless AND purge the doc's Qdrant chunks via `vectorStore.deleteByDocId` (best-effort: Qdrant cleanup failure logs `trash_qdrant_purge_failed` but never fails the user request). Nav-bar Papierkorb badge polls `?page_size=1` on the same 30s cadence as the in-flight pill. |
| Duplikat-Erkennung (`ai-duplicate` aux tag)                                                     | ✅ Field-based detector at `packages/aktenraum-core/src/dedup.ts` (lifted from auto-tagger so aktenraum-api can also import it for the on-demand duplicate-candidates endpoint). Runs inline in `propagate.processApprovedDocument` after every successful propagation: fetches up to 200 `ai-propagated` docs filtered to the new doc's correspondent, and flags pairs that share correspondent + `ai_issue_date` + `ai_document_type` (when both sides have a type — backward-compat with older corpora) AND ((monetary amounts within 0.01 EUR) OR (any `ai_reference_numbers` overlap). Both pair members are tagged `ai-duplicate` (idempotent). The type discriminator fixes the common false positive where a Rechnung + its Beleg (payment confirmation) from the same vendor on the same day for the same amount used to be flagged. The tag is in `_BADGE_TAGS` so Library rows render a purple pill. **Sticky dismissal**: clicking "Kein Duplikat" on the detail page adds `ai-duplicate-dismissed`; the helper skips docs carrying that tag on future propagations. **On-demand candidate list**: `GET /api/documents/{id}/duplicate-candidates` re-runs the same detector against the live corpus so the detail page can render "Mögliches Duplikat von #N" links. |
| Important star (`wichtig` user tag)                                                             | ✅ ★ toggle (`components/StarToggle.vue`) in the header of the library and inbox detail pages (`POST`/`DELETE /api/documents/{id}/star`, which also fires `reindex-metadata` so the Qdrant payload follows). The tag is plain Paperless — filterable via `/library?tags=wichtig`. Library rows sort `wichtig` first (`sortTagsImportantFirst` in `apps/web/app/utils/library.ts`) and render it as a gold ★ pill. Auto-created on first star and pre-seeded by `scripts/bootstrap-paperless.sh`. UI added 2026-10-01 — before that the endpoint existed with no button. |
| Email ingestion (IMAP → consume pipeline)                                                       | ✅ Opt-in via `AKTENRAUM_MAIL_*` in `docker/.env`. `scripts/bootstrap-paperless.sh` auto-loads those vars and provisions a Paperless mail account + rule (idempotent: re-runs reconcile drift incl. password rotation). Paperless polls the mailbox every ~10 minutes; attachments matching `*.pdf,*.png,*.jpg,*.jpeg,*.tif,*.tiff` flow through the same consume pipeline as the watched folder (SHA1 dedup, OCR, auto-tagger). Each ingested doc gets the `email-ingested` tag (sky blue, `#0ea5e9`) so the user can filter via `/library?tags=email-ingested`. Rule defaults: INBOX, MARK_READ after consume, max 30 days history on first poll, filename-as-title. Provider-agnostic — Gmail (App Password), Outlook, Fastmail, self-hosted IMAP. Unsetting `AKTENRAUM_MAIL_IMAP_SERVER` does NOT delete an existing account; remove via Paperless's admin UI. |
| Remote access via Tailscale (testing-phase topology)                                            | ✅ Runbook + ADR-005 — `tailscale serve --bg --https=443 http://localhost:8080` on the host, `https://<host>.<tailnet>.ts.net/` from any tailnet device. No public exposure. See `docs/runbooks/tailscale-remote-access.md` and `docs/adr/005-test-phase-access-via-tailscale.md`. Status: `tailscale serve status`.                                                                                                                                |
| Self-service password change (`POST /api/auth/change-password` + Konto section on `/settings`)  | ✅ Verifies current password + min 8-char new password + `new != current`. Success clears the session cookie (forces re-login on the current device; other devices' JWTs expire on their own at the 8h default). No DB schema change. Replaces the previous "edit bcrypt hash via psql" workaround for password rotation.                                                                                                                                                       |
| Mobile responsiveness (`md:` breakpoint = 768px, `lg:` = 1024px)                                | ✅ Nav collapses to hamburger drawer below `md:`. Library archive: sidebar collapses behind a "Filter & Tags" toggle on mobile; table swaps to a card-list (one `<li>` per doc). Library review tab: same table-to-cards swap. Inbox/Library detail pages: stacked two-pane gets a "PDF / Bearbeiten" tab toggle below `lg:` so the user isn't scrolling past a full-height iframe to reach the form. Keyboard-shortcut hints in detail pages are `hidden md:inline` (no kbd on phones). Touch targets bumped to 40-44px on mobile via responsive `h-10 w-10 sm:h-auto sm:w-auto` pattern. All other pages (Login / Home / Ask / Find / Trash / Upload / Settings) verified mobile-OK with the existing single-column layouts. |
| Backup integrity checks (`restic check`)                                                        | ✅ Weekly `restic check --read-data-subset=5%` in the backup entrypoint (Sundays; `BACKUP_FORCE_CHECK=true` to force). On-demand via `restic check` in the backup container (see the Backup section); full recoverability rehearsal (check + filesystem restore to staging + both DB dumps validated) via `task backup:verify` / `docker/backup/verify-backup.sh`. |
| Node.js/Angular rewrite (`rewrite-stack-nodejs-angular`)                                        | ✅ **Complete — see [ADR-007](docs/adr/007-nodejs-angular-migration.md).** The stack is TypeScript end to end: `@aktenraum/core` (shared lib), `@aktenraum/api` (NestJS, ESM), `@aktenraum/worker` (5 concurrent loops), `@aktenraum/web` (Angular 22, zoneless — since replaced by Nuxt, see the row above). The Python services, the React SPA, the uv workspace and the `X-Aktenraum-Backend` strangler switch are all deleted. Verified live: upload → webhook → extraction → routing → propagation → Qdrant indexing, plus a 20-assertion e2e run (`bash scripts/e2e-worker.sh`). |
| Mobile document scan (`/scan`)                                                                  | ❌ **Removed 2026-08-11** — see [ADR-006](docs/adr/006-drop-mobile-document-scan.md). Route, libs, Nav/Home entry points and the `pdf-lib` + `react-image-crop` deps are gone; the OpenSpec change is archived. Mobile capture is now "photograph with the OS camera, upload via `/upload`". |
| Health endpoint / Prometheus metrics                                                            | 🔲 Planned                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

---

## Development workflow

One pnpm workspace, one lockfile, four packages. Run everything from the **repository root**.

```bash
pnpm install          # install all four packages
pnpm -r build         # task build — tsc -b ×3 + `nuxt generate`
pnpm -r test          # task test     — 644 tests across every package
pnpm -r lint          # task lint     — eslint everywhere
```

Per-package: `pnpm --filter @aktenraum/core test`, `pnpm --filter @aktenraum/api test`, `pnpm --filter @aktenraum/worker test`, `pnpm --filter @aktenraum/web test`.
`pnpm --filter @aktenraum/api typecheck` runs `tsc -p tsconfig.test.json`, which typechecks the test files that `vitest` would otherwise transpile without checking.

Test counts and what they cover:

| Package | Tests | Shape |
| --- | --- | --- |
| `@aktenraum/core` | 176 | pure functions — normalisers, chunker, models, the Paperless client against a fake fetch |
| `@aktenraum/api` | 193 | real Nest app over **pg-mem** + a stateful fake Paperless, driven with supertest |
| `@aktenraum/worker` | 125 | routing matrix, queue semantics, prompt assembly, synthesizers, plus extraction/propagation/indexing flows against an in-memory fake Paperless |
| `@aktenraum/web` | 150 | vitest + `@nuxt/test-utils` (`environment: "nuxt"`, `mountSuspended`, `mockNuxtImport`) |

After a code change: `task build` rebuilds all three images. Every Dockerfile's build context is the repo root, so an edit in `packages/aktenraum-core/src/` is picked up by rebuilding either service.

For an inner loop without rebuilds, the dev overlay (`docker compose --project-directory docker -f docker/docker-compose.yml -f docker/docker-compose.dev.yml up -d aktenraum-api auto-tagger`) bind-mounts `src/` into both services and runs `tsx watch` — a `.ts` save restarts the process in about a second. `docker compose --project-directory docker up -d aktenraum-api auto-tagger` restores the prod entrypoints.

The Nuxt dev server (`task web:dev`) serves on `:4300` and proxies `/api` to the nginx edge on `:8080` (`nitro.devProxy` in `apps/web/nuxt.config.ts`). Production deploys bake the SPA into the nginx image in a multi-stage build — no Node needed at deploy time.

**End-to-end**: `bash scripts/e2e-worker.sh` runs the whole pipeline against a throwaway Paperless/Postgres/Qdrant stack. It never touches the live stack and refuses to start on live-stack ports.

CI (`.github/workflows/ci.yml`) is one job: `pnpm install` → `pnpm -r lint` → `pnpm -r build` → typecheck → `pnpm -r test`.

---

## aktenraum-api notes

- NestJS app bootstrapped in `src/main.ts`, listening on port 8002. It runs as **ESM** — `@aktenraum/core` is ESM-only and a CJS build produced a dual-package hazard.
- **`applySchema()` runs before `NestFactory.create`.** It applies `src/db/schema.sql` (idempotent `CREATE TABLE IF NOT EXISTS`) in one transaction. Module init hooks query `users` and `auto_approve_rules`; without this a fresh database dies at boot. Note `src/db/0000_certain_guardian.sql` is drizzle-kit *introspection* output and is entirely commented out — a drift oracle, not a migration.
- Auth: HS256 JWT in an httpOnly `SameSite=Lax` cookie. The SPA never reads the token. `JWT_SECRET` is required at startup; missing/empty → the service exits non-zero.
- Bootstrap: on startup, if `users` is empty AND `BOOTSTRAP_USERNAME` + `BOOTSTRAP_PASSWORD` are set, one user is inserted. A reconciler inserts an `auto_approve_rules` row for any `DocumentType` missing one. Both idempotent across restarts.
- DB: drizzle-orm over a node-postgres `Pool` (`src/db/db.module.ts`, injected as `DB` / `DB_POOL`).
- Schema: `src/db/schema.sql`, applied by `applySchema()` at startup (see above). `src/db/schema.ts` is the Drizzle model; `apply-schema.test.ts` fails if the two drift, so a new table must be added to both.
- The `aktenraum` Postgres database is created by `docker/postgres-init/01-create-aktenraum-db.sh` on a fresh `pgdata` volume. **For existing installs**, run once: `docker compose exec postgres psql -U paperless -c "CREATE DATABASE aktenraum OWNER paperless;"`

### AI: Find docs (`/api/ai/find`)

> **Note (2026-06-01)**: the SPA `/find` page + `FilterChips` component + the `useFind` client hook were removed; AI search folded into Ask AI. The backend endpoint below still exists and is tested but is no longer called by the frontend.

- `POST /api/ai/find` is the structured-search endpoint. Auth-gated. Accepts either `{"query": str}` (LLM path) or `{"filter": SearchFilter}` (no LLM, used for chip-edit re-runs). Returns `{filter, results, explanation, total}`.
- `SearchFilter` is closed-enum: `document_type` reuses `DocumentType` from `@aktenraum/core`, plus `correspondent`, `date_from`, `date_to`, `text`, `tags`. Unknown doc types → 422. Cross-type amount filtering was removed when the generic `monetary_amount` field was retired — money lives on type-specific schemas only (Rechnung.gesamtbetrag, Mahnung.forderungsbetrag, etc.).
- Server-side `PaperlessGateway` (`src/paperless/paperless.gateway.ts`) holds the API token; per-process correspondent / tag / custom-field-id caches; the token never reaches the SPA.
- Translator (`src/ai/translate.ts`) → Paperless query params using `document_type__id` / `correspondent__id` (the bare names are silently ignored — same gotcha class as `?name=` on `/api/tags/`).
- Prompt (`src/ai/prompt.ts`) inlines the doc-type taxonomy, the live correspondent list (cap 200), date rules, and a few German few-shot exemplars. An explicit note tells the LLM there are no amount fields on the filter. **Modular extras**: `ai/intent.ts` `detectIntents(query)` runs a German keyword classifier (`SALARY` / `SPENDING` / `TAX` / `INSURANCE` / `HOUSING` / `MEDICAL` / `ID_DOCUMENT` / `CAR` / `CONTRACT`); whenever an intent fires, the matched `ai/prompt-modules.ts` `MODULES[docType].filterExamples` are appended to the few-shot block so the LLM sees a typed mapping for the shape at hand. Neutral queries fall through to the static set unchanged (prompt-cache stable). Substring match by default — short ambiguous keywords (`pass`, `lohn`) opt into strict whole-word matching via `STRICT_KEYWORDS`.

### AI: Conversational answer (`/api/ai/answer`)

- `POST /api/ai/answer` runs a two-step pipeline: filter extraction → retrieval → second LLM call that reads the AI metadata of the top matches and produces a German prose answer with citations.
- Response shape: `{question, answer_de, citations: list[DocumentSummary], filter, total}`. Hallucinated citation ids are dropped server-side (intersection with the searched docs).
- Retrieval broadens the filter for the answer step: when any structural field (doc_type, correspondent, dates, amounts) is set, we drop the `text` constraint — verbs like "verlängern" / "kostete" land in `text` from the filter LLM but rarely appear in OCR'd content, so keeping them kills recall. `/find` keeps `text` honored.
- The answer prompt (`src/ai/answer-prompt.ts`) is **assembled per request from `ai/prompt-modules.ts`**: `assembledFieldHints(candidates)` enumerates each distinct doc type present in the retrieved set, lists its `TYPE_FIELD_SCHEMA` labels and the module's `answer_hint` in the system message; `assembledExamples(candidates, jsonMode)` emits one module example per distinct type in the user message. `toJsonEnvelope` lets the JSON `/answer` and streaming `/answer/stream` paths share the same per-type examples without duplicating strings. The static cross-doc aggregation example (Wizz-Air style) and the citation-marker rule stay always-on — they teach syntax, not domain. Module entries cover every `DocumentType` enum value (the `Record<DocumentType, …>` type, which makes a missing type a compile error); field labels come from `TYPE_FIELD_SCHEMA` so adding a typespecific field there automatically widens the prompt.
- Two LLM backends: the filter-extraction call uses `OLLAMA_MODEL` / `ANTHROPIC_MODEL`; the answer call optionally uses `OLLAMA_ANSWER_MODEL` / `ANTHROPIC_ANSWER_MODEL` so a deployer can pair a fast 8B for filters with a smarter 14B+ for answers (the 8B is too small to read citations reliably).

### AI: Streaming answer + RAG (`/api/ai/answer/stream`)

The user-facing /ask page consumes this endpoint, NOT `/api/ai/answer`. The streaming variant adds two things:

1. **SSE token-by-token streaming.** Replaces the silent ~30s wait with `meta` → repeated `chunk` → `final` (or `error`) events. Inline `[Quelle: <id>]` markers in the streamed prose are regex-extracted post-hoc and intersected with retrieved docs to populate citations. The streaming-specific prompt (`buildStreamingAnswerMessages`) instructs the model to use the marker format and is prose-only (NOT JSON envelope).
2. **RAG retrieval (Phase 1).** When `QDRANT_URL` is set, every question runs through `src/ai/retrieval.ts` `retrieveChunksForQuestion`: embed query (qwen3-embedding:4b) → Qdrant search top-50 with payload filter → bge-reranker-v2-m3 cross-encoder rerank → top-5 chunks. Those chunks land under "Relevante Auszüge:" inside each candidate's prompt block, alongside the existing AI metadata fields. This is what answers questions whose information is in the document body (CV employment durations, contract clauses, table values) — pre-RAG the LLM only ever saw `ai_summary_de` + dates + amounts.

**Retrieval order (2026-10-01, `fix-ask-retrieval`)**: RAG runs before the empty-result check, so a wrong structured guess (e.g. `Zeugnis` for a CV filed as `Sonstiges`) no longer short-circuits to "nicht gefunden" — the no-match answer fires only when structured search AND RAG are both empty. The Qdrant filter is derived from the broadened filter (tags dropped; correspondent kept only when it case-insensitively matches a known Paperless correspondent, since the payload stores the native name) and retries once unfiltered when the filtered search is empty (`rag_retrieve_unfiltered_fallback`). Prompt slots: RAG-ranked docs first (≤5), then structured results, capped at `ANSWER_CONTEXT_SIZE` (15). Citations resolve only against docs that were in the prompt. Each candidate is wrapped in `<dokument id="N">…</dokument>` (any `</dokument` inside the text is neutralised) and the system prompt says text inside is data, never instructions — the indirect-prompt-injection guard for e-mail-ingested documents. Precomputed per-type totals are labelled UNVOLLSTÄNDIG when the structured `total` exceeds the prompt candidates.

Resilience: any RAG stage failing degrades gracefully (embedder error → empty result, qdrant error → skip rerank, reranker error → fall through to dense-only ordering). Empty / `QDRANT_URL`-unset → falls back to the AI-metadata-only path so the endpoint keeps working.

The bge-reranker-v2-m3 model is **pre-warmed at startup** as a background task (`src/ai/retrieval.module.ts`) so the first `/ask` after a fresh container is not blocked by the ~570 MB HF download (the quantized ONNX export). The download lands in the `aktenraum-node-hf-cache` named volume (mounted at `/home/appuser/.cache/huggingface`, pinned via `HF_HOME` / `HUGGINGFACE_HUB_CACHE`), so it survives `docker compose up -d --build aktenraum-api`. End-to-end warm took ~80s on the dev host on first run; subsequent rebuilds are instant because the cache persists. Steady-state rerank is ~50 ms × 50 candidates ≈ 2.5s. If a request lands while the warm-up is still running the reranker's in-flight promise makes it wait on the existing load instead of starting a second one. **Volume permissions gotcha**: a fresh named volume mounts as root-owned; the Dockerfile pre-creates `/home/appuser/.cache/huggingface` with `appuser` ownership so Docker copies the right mode into the volume on first attach. If you ever see `reranker_prewarm_failed` with a `PermissionError`, the volume was created before the Dockerfile fix — `docker volume rm docker_aktenraum-node-hf-cache` and rebuild.

**Denial suppresses citations.** When the answer LLM writes the prompt-baked "I couldn't find that" template (`DENIAL_RE` in `ai.service.ts` — matches "in den Dokumenten nicht finden", "keine passenden Dokumente", "keines der Dokumente enthält", and three more variants, length-capped at 200 chars), the no-citations back-fill is skipped and the SPA renders the denial alone. Without this gate the back-fill rule ("if the model wrote prose but cited nothing, surface the retrieved set so the user has a source to verify against") rendered source cards beneath a "nicht gefunden" message, which looked like the AI was lying about its own search. The gate is strict — partial answers longer than 200 chars that happen to contain a denial phrase still get their citations back-filled.

### RAG: indexing pipeline (auto-tagger)

Indexing fans out from propagation. When a doc reaches `ai-propagated`, the propagator enqueues its id on the `indexing_queue`; a fifth concurrent task in the auto-tagger drains the queue and runs:

```
fetch document by id from Paperless
  ↓
chunk content (paragraph-aware, ~500 tokens, ~50-token overlap)
  ↓
batch-embed via Ollama (single round-trip per doc)
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
- Money is no longer exposed at this layer — type-specific schemas carry it (Rechnung.gesamtbetrag, Mahnung.forderungsbetrag, Versicherung.jahrespraemie, etc.). The library and inbox detail pages surface them via `components/TypeFieldsSection.vue`.
- SPA route `/library` keeps filter state in URL search params (bookmarkable; back-button works); auto-applies form changes after a 400ms debounce; click row → `/library/$id`.
- `/library/$id` is the per-document review: PDF iframe on the left, editable form for the AI fields on the right (Speichern / Zurücksetzen / Erneut verarbeiten / Löschen / Herunterladen / ★). Backed by `GET /api/documents/{id}/detail` and `PATCH /api/documents/{id}/fields` — both reuse `aktenraum-api inbox.service` so they work on any doc, not just pending. Edits update only the AI fields; the propagator only runs on `ai-approved`, so to also rewrite the native Paperless fields the user clicks **Erneut verarbeiten** (which restarts the full pipeline). **Löschen** is a two-click confirm that moves the doc to the Papierkorb (`DELETE /api/documents/{id}`) and returns to `/library`. A doc tagged `ai-duplicate` shows `components/DuplicatePanel.vue` ("Mögliches Duplikat von #N" links from `/duplicate-candidates` + "Kein Duplikat"). Below the buttons, `components/TypeFieldsSection.vue` edits the type's `TYPE_FIELD_SCHEMA` fields (also on `/inbox/$id`); it PATCHes only changed keys to `/api/documents/{id}/type-fields`, sending `null` for an emptied field, which the API treats as "clear" (the worker never sends `null`, so a reprocess can't wipe a hand-typed value). There is no preview modal — Ask citations link to `/library/$id`.

### Upload + Reprocess (`/api/documents/upload`, `/api/documents/{id}/reprocess`)

- `POST /api/documents/upload` accepts `multipart/form-data` with one or many `files`; each is forwarded to Paperless's `/api/documents/post_document/`. Per-file failures are isolated — the response is `{results: [{filename, status, task_id, detail}]}`. Paperless dedupes by SHA1 so re-uploading the same content is a silent no-op.
- `POST /api/documents/{id}/reprocess` clears every lifecycle tag (`ai-pending`/`ai-approved`/`ai-rejected`/`ai-propagated`/`ai-propagation-error`/`ai-error` plus `ai-low-confidence`) so the document looks fresh to the auto-tagger; then best-effort pings `http://auto-tagger:8001/trigger/extract` for instant re-extraction. Without the ping (or if it fails) the auto-tagger's 30s poller picks the doc up regardless.
- New env: `AUTO_TAGGER_URL` (default `http://auto-tagger:8001`) and `WEBHOOK_SECRET` (must match auto-tagger's; empty disables the secret on both sides). Both optional.
- SPA: `/upload` route with drag-and-drop + per-file progress; "Erneut verarbeiten" button on the library detail page with a two-click confirm. Reprocess success invalidates the `library` and `inbox` query caches so the UI snaps to the new state.

### Processing visibility (`/api/documents/in-flight`, `/task/{uuid}`, `/{id}/status`)

- `GET /api/documents/in-flight` returns `{count}` — number of docs carrying `ai-pending` or `ai-approved` (driven by `tags__id__in`). Empty lifecycle tags are intentionally excluded so legacy / non-AI docs don't keep the Nav badge stuck >0.
- `GET /api/documents/task/{uuid}` proxies Paperless's `/api/tasks/?task_id=…` and projects to `{task_id, status, doc_id, result}`. `doc_id` comes from `related_document` when present, falling back to a regex on the result string ("Success. New document id 19 created") so older Paperless versions still surface a usable id.
- `GET /api/documents/{id}/status` is a lightweight `{id, lifecycle_tags}` lookup used by the upload-page poller.
- `DocumentSummary` (returned by `/find` and `/answer` citations) carries `lifecycle_tags` so a single `ProcessingBadge` component renders the same status pill everywhere a doc card appears (Library rows, Find result cards, Ask citations). Empty list → "Wartet auf KI".
- SPA upload polling: after `/documents/upload` returns the Paperless task UUID, poll `/task/{uuid}` every 1.5s until SUCCESS, then poll `/{doc_id}/status` every 3s until a lifecycle tag appears or the 120s ceiling hits. The page renders one of: `Bereit → Wird hochgeladen → Paperless verarbeitet… → KI klassifiziert… → ✓ in der Inbox / ✓ in der Bibliothek / ✗ Fehler` per file.
- Nav shows a global "N in Bearbeitung" pill (in-flight count minus inbox count, so it represents docs the _auto-tagger_ is processing right now — pending docs already get the Inbox badge). Values come from the live-counts SSE stream, with a 30s Vue Query poll as fallback.

### Document proxy (`/api/documents/{id}/{preview,download}`)

- `GET /api/documents/{id}/preview` streams the inline PDF preview (`Content-Type: application/pdf`, `Cache-Control: private, max-age=300`). Embedded as an iframe on the library and inbox detail pages.
- `GET /api/documents/{id}/download` streams the original file with the upstream `Content-Disposition` forwarded so the browser saves with the right filename.
- Both proxy through `aktenraum-api` so the Paperless API token stays server-side. nginx's `proxy_read_timeout` is bumped to 300s in `docker/nginx/nginx.conf` because LLM-backed endpoints can take ~30s on bigger local models.

Without `PAPERLESS_API_TOKEN` set, `/api/ai/*` and `/api/documents/*` respond 503 while `/api/health` and `/api/auth/*` stay green. Same for missing `ANTHROPIC_API_KEY` when `LLM_BACKEND=anthropic`.

### Inbox review (`/api/inbox/*`)

- `GET /api/inbox/` paginated list of `ai-pending` documents (oldest-first); `GET /api/inbox/{id}` full review payload (12 ai\_\* fields + content excerpt + tags); `PATCH /api/inbox/{id}` partial field update; `POST /api/inbox/{id}/approve` (optional patch body, then swaps `ai-pending` → `ai-approved`); `POST /api/inbox/{id}/reject`; `GET /api/inbox/{id}/preview` streams the PDF with `Content-Type: application/pdf`, `Cache-Control: private, max-age=300`. All auth-gated.
- Lifecycle-tag swap is a single `tags=[…]` PATCH planned by `planTagSwap` (pure helper). Idempotent re-approve / re-reject is a no-op.
- **Paperless `custom_fields` PATCH is full-array replace**, not partial upsert — sending only `{ai_correspondent: …}` would wipe the other 11 fields. The gateway's `patchDocumentCustomFields` reads the existing array, merges the requested updates by field id (`mergeCustomFields`), then writes back. Same gotcha class as the silent `?name=` and `?correspondent=` filters.
- Field-update normalisation reuses the normalisers in `@aktenraum/core` — date fields go strict ISO, monetary becomes `<ISO><amount>`, strings get truncated to 128 chars. Server-side at the boundary; client cannot bypass.
- SPA: the review queue lives at `/library?tab=review` (`apps/web/app/components/library/ReviewTab.vue`, rendered by `pages/library/index.vue`). There is no bare `/inbox` route — it falls through to the `[...slug].vue` not-found page. The list supports **multi-select bulk approve**: per-row checkboxes + a header "select all" checkbox + a sticky dark action bar that runs `useBulkApprove` (parallel POSTs against `/api/inbox/{id}/approve`) and reports `N genehmigt · M fehlgeschlagen`. **Pagination is load-more, not page-jump**: the tab uses `useInboxListInfinite` (TanStack `useInfiniteQuery`, pageSize=50) so multi-select spans loaded chunks naturally — review is a triage flow, not random-access browsing. "Mehr anzeigen" button below the table renders while `hasNextPage`; counter shows `N von M geladen`. Bulk-approve `invalidateQueries({queryKey: INBOX_KEY})` invalidates all loaded pages, triggering a sequential refetch (acceptable: refetch only fires once per bulk operation, and the refetched state is usually much smaller because most loaded docs just got approved). Per-doc detail page is `/inbox/$id` — two-pane review (PDF iframe via the proxy + editable form), keyboard shortcuts `a` Approve / `r` Reject / `j`,`k` next/prev / `Esc` back. Auto-advance to the next pending doc on action; back-out / Escape navigate directly to `/library?tab=review` (no redirect hop).

`prompt.ts` disables `max-len` for the file on purpose: `SYSTEM_PROMPT` is a long German-text block where wrapping damages the prompt as content. Its exact length (14,118 chars) is asserted by a test, so an accidental edit fails CI rather than silently changing extraction behaviour on every document.

## COMMIT AND PUSH RULES

- NEVER EVER commit anything before running tests locally..
- NEVER EVER commit after fixing a bug without me first confirming that the bug is fixed
