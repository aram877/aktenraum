# Development guide

Everything you need to start the stack, develop against it, and ship a
change. For why the stack looks the way it does see
[architecture.md](architecture.md); for every env-var knob see
[configuration.md](configuration.md).

The code is TypeScript end to end in one pnpm workspace:

| Package | Path | What |
|---|---|---|
| `@aktenraum/core` | `packages/aktenraum-core` | shared library: Paperless client + normalisers, LLM backends, models, RAG |
| `@aktenraum/api` | `services/aktenraum-api` | NestJS HTTP API for the SPA (port 8002) |
| `@aktenraum/worker` | `services/auto-tagger` | extraction / propagation / indexing worker (port 8001) |
| `@aktenraum/web` | `apps/web` | Nuxt 4 SPA, statically generated and served by nginx |

Run every `pnpm` and `task` command from the repository root. In the raw
commands below, `DC` stands for `docker compose --project-directory docker`.

---

## Prerequisites

- Docker Desktop or Docker Engine + Compose v2.
- `bash` (macOS, Linux, or Windows Git Bash).
- [`task`](https://taskfile.dev) — recommended (`brew install go-task` / `winget install Task.Task`). `task --list` enumerates the shortcuts.
- For editing code, running tests or the Nuxt dev server: Node 22 (`.nvmrc`) and pnpm 9 (`corepack enable`; the version is pinned by `packageManager` in `package.json`).
- For Ollama (default LLM backend): Ollama on the host, plus `ollama pull qwen2.5:14b-instruct-q8_0` (~16 GB; `qwen2.5:32b-instruct-q8_0` if you have ~32 GB to spare) and `ollama pull qwen3-embedding:4b`. The containers reach it via `http://host.docker.internal:11434`.
- For backups: nothing — the `backup` service ships its own restic. A host `restic` is only needed for the optional `scripts/backup.sh`.

You do not need Node installed just to run the stack — every image builds
inside Docker.

## Task runner

The full list is in [`Taskfile.yml`](../Taskfile.yml):

| Task | What it does |
|---|---|
| `task setup` | first-time setup: host dirs → secrets → stack → Paperless token → custom fields + tags → restic init → first snapshot |
| `task start` / `task stop` / `task status` | bring the stack up (recreating services whose `docker/.env` values changed) / take it down (data kept) / show what runs |
| `task logs SVC=<service>` | tail one service; omit `SVC` for all |
| `task build` | rebuild and restart nginx (SPA) and both Node services |
| `task web:dev` | Nuxt dev server on `:4300`, proxying `/api` to `:8080` |
| `task test` / `task lint` | vitest / eslint across all four packages (runs `pnpm install` first) |
| `task recover` | re-mint the Paperless API token and recreate both Node services |
| `task destroy` | stop the stack and delete `AKTENRAUM_DATA_DIR` (asks for `DELETE`) |
| `task rag:reembed` | drop the Qdrant collection and re-embed every document |
| `task backup:verify` | non-destructive DR rehearsal: `restic check` + test restore + both DB dumps |

---

## First-time setup

```bash
git clone <this-repo>
cd aktenraum
bash scripts/bootstrap-secrets.sh    # creates docker/.env from docker/.env.example
# edit docker/.env: set AKTENRAUM_DATA_DIR to an absolute path (required)
task setup
```

`bootstrap-secrets.sh` is idempotent. It copies `docker/.env.example` to
`docker/.env` if absent and fills every empty REQUIRED value with
`openssl rand`. It prints the generated admin and SPA passwords **once**;
save them. `task setup` runs it again (a no-op) and then does the rest.

Without `task`, the same steps by hand:

```bash
bash scripts/setup.sh                       # host directories under ~/aktenraum
bash scripts/bootstrap-secrets.sh
DC up -d
bash scripts/fix-token.sh                   # mint PAPERLESS_API_TOKEN, recreate the Node services
TOKEN=$(grep '^PAPERLESS_API_TOKEN=' docker/.env | cut -d= -f2-)
docker cp scripts/bootstrap-paperless.sh docker-paperless-1:/tmp/bootstrap-paperless.sh
DC exec -T -e PAPERLESS_API_TOKEN="$TOKEN" paperless bash /tmp/bootstrap-paperless.sh
DC exec -T backup sh -c 'restic -r /repo snapshots >/dev/null 2>&1 || restic -r /repo init'
```

To mint the token manually instead of `fix-token.sh`:

```bash
curl -s -X POST http://localhost:8000/api/token/ -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<PAPERLESS_ADMIN_PASSWORD>"}'
# put the value into PAPERLESS_API_TOKEN= in docker/.env, then:
DC up -d auto-tagger aktenraum-api           # recreate; restart does not re-read env
```

The SPA is at <http://localhost:8080>. Log in with `BOOTSTRAP_USERNAME` /
`BOOTSTRAP_PASSWORD` from `docker/.env`. On plain-HTTP localhost set
`COOKIE_SECURE=false` there first, or the session cookie is never sent.

A longer walkthrough lives at
[runbooks/first-time-setup.md](runbooks/first-time-setup.md).

---

## Daily start / stop

```bash
task start                           # backend stack
task web:dev                         # optional: Nuxt dev server on :4300
task stop                            # data preserved
```

<http://localhost:4300> serves the hot-reloaded SPA against the running
stack; `/api` is proxied to the nginx edge on `:8080` (`nitro.devProxy` in
`apps/web/nuxt.config.ts`). The production SPA on `:8080` is unaffected.

For the Node services, the dev overlay
[`docker/docker-compose.dev.yml`](../docker/docker-compose.dev.yml)
bind-mounts `src/` of both services and of `@aktenraum/core` and runs
`tsx watch`, so a `.ts` save restarts the process in about a second with no
image rebuild:

```bash
DC -f docker/docker-compose.yml -f docker/docker-compose.dev.yml up -d aktenraum-api auto-tagger
DC up -d aktenraum-api auto-tagger   # back to the compiled prod entrypoints
```

`node_modules` stay the ones baked into the image, so adding a dependency
still needs a rebuild.

---

## Rebuilding after code changes

`docker compose restart` does **not** re-read `docker/.env` or pick up
source changes.

| You changed | Task | Raw command |
|---|---|---|
| `services/auto-tagger/**` | `task build` | `DC up -d --build auto-tagger` |
| `services/aktenraum-api/**` | `task build` | `DC up -d --build aktenraum-api` |
| `packages/aktenraum-core/**` | `task build` | `DC up -d --build auto-tagger aktenraum-api` |
| `apps/web/**` or `docker/nginx/**` | `task build` | `DC up -d --build nginx` |
| `docker/backup/**` | — | `DC up -d --build backup` |
| any `docker/.env` value | `task start` | `DC up -d <service>` |
| `docker/docker-compose.yml` | `task start` | `DC up -d` |

Every Dockerfile's build context is the repo root, so rebuilding either
Node service picks up `@aktenraum/core` edits.

---

## Running tests

```bash
task test                            # pnpm install + pnpm -r test (644 tests)
task lint                            # pnpm install + pnpm -r lint
pnpm -r build                        # tsc -b for the Node packages + nuxt generate
```

One package at a time, or one file:

```bash
pnpm --filter @aktenraum/api test                    # one package
pnpm --filter @aktenraum/worker test -- prompt       # files matching "prompt"
pnpm --filter @aktenraum/api typecheck               # tsc over the test files, which vitest only transpiles
pnpm --filter @aktenraum/web typecheck               # nuxt typecheck
```

| Package | Tests | Shape |
| --- | --- | --- |
| `@aktenraum/core` | 176 | pure functions — normalisers, dedup, chunker, models, the Paperless client over a fake fetch |
| `@aktenraum/api` | 193 | a real Nest app over **pg-mem** plus a stateful fake Paperless, driven with supertest |
| `@aktenraum/worker` | 125 | routing matrix, queue semantics, prompt assembly, synthesizers, extraction/propagation/indexing flows against a fake Paperless |
| `@aktenraum/web` | 150 | vitest + `@nuxt/test-utils` (`environment: "nuxt"`, `mountSuspended`, `mockNuxtImport`) |

None of these need the stack running.

### End to end

```bash
bash scripts/e2e-worker.sh           # build + run the throwaway stack, assert each pipeline stage
bash scripts/e2e-worker.sh --down    # tear it down (deletes its volumes)
```

It drives the real worker through webhook → extraction → routing →
propagation → dedup → Qdrant indexing against an isolated stack
([`docker/docker-compose.e2e.yml`](../docker/docker-compose.e2e.yml), project
`aktenraum-e2e`, ports 8100/8101/8102/6433). It never touches the live stack
and refuses to start on live-stack ports. Never point a second worker at the
live Paperless while the stack's auto-tagger runs — both claim documents by
writing lifecycle tags.

### CI

GitHub Actions ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml))
runs one job on every push to `main` and every PR: `pnpm install` →
`pnpm -r lint` → `pnpm -r build` → api and web typecheck → `pnpm -r test`.

---

## Logs and debugging

When debugging, start from the logs. Both Node services write one JSON object
per line with an `event` field.

```bash
task logs SVC=auto-tagger            # or: DC logs -f auto-tagger
task logs SVC=aktenraum-api
DC logs --tail=50 paperless

# A doc's current state
TOKEN=$(grep '^PAPERLESS_API_TOKEN=' docker/.env | cut -d= -f2-)
curl -s -H "Authorization: Token $TOKEN" \
  "http://localhost:8000/api/documents/<ID>/" | python3 -m json.tool

# Trigger extraction on a specific doc (bypasses the 30 s poll lag)
DC exec paperless curl -sS -H "Content-Type: application/json" \
  -H "X-Aktenraum-Secret: $(grep '^WEBHOOK_SECRET=' docker/.env | cut -d= -f2-)" \
  -d '{"document_id": <ID>}' http://auto-tagger:8001/trigger/extract
```

Worker events worth grepping for:

| Event | Meaning |
|---|---|
| `worker_started` | Service start (loop count, propagation and RAG on/off) |
| `extraction_successful` | LLM call returned a valid extraction |
| `extraction_deferred` | Transient LLM failure (timeout, connection, 429/5xx); retried on the next poll |
| `extraction_failed` | Permanent failure; doc gets `ai-error` |
| `fallbacks_applied` | The LLM dropped fields; synthesizers filled them (`fields=[…]`) |
| `routing_decision` | Lifecycle tag(s) applied, with `reason=…` |
| `active_llm_model_unreachable_using_env` | api unreachable at cold start; using `OLLAMA_MODEL` |
| `auto_approve_rules_unreachable_fail_closed` | api unreachable at cold start; everything routes to `ai-pending` |
| `paperless_patch_rejected` | Paperless 4xx with the response body verbatim |
| `skip_already_processed` | Webhook + poller race; this one is the duplicate |
| `skip_not_approved` | Propagation skipped a doc that no longer carries `ai-approved` |
| `indexer_doc_indexed` | RAG chunks upserted into Qdrant |
| `index_reconcile_completed` | Startup sweep that re-queues propagated docs with no chunks |

---

## Common tasks

### Inspect Paperless via API

```bash
TOKEN=$(grep '^PAPERLESS_API_TOKEN=' docker/.env | cut -d= -f2-)
BASE=http://localhost:8000

# All tags (?name= is silently ignored — use ?name__iexact=)
curl -s -H "Authorization: Token $TOKEN" "$BASE/api/tags/?page_size=200" | python3 -m json.tool

# All custom fields with their ids
curl -s -H "Authorization: Token $TOKEN" "$BASE/api/custom_fields/?page_size=100" | python3 -m json.tool

# Search documents (use document_type__id, not document_type=)
curl -s -H "Authorization: Token $TOKEN" "$BASE/api/documents/?document_type__id=5&ordering=-created" | python3 -m json.tool
```

### Reprocess a single document

Use "Erneut verarbeiten" in the SPA (clears the lifecycle tags and pings the
worker), or clear the tags yourself; the 30 s poller re-extracts it:

```bash
curl -s -X PATCH "http://localhost:8000/api/documents/<ID>/" \
  -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
  -d '{"tags": []}'
```

`{"tags": []}` removes every tag, including user tags such as `wichtig`.

### Reprocess every document

Useful after a prompt change. Cost: one LLM call per doc.

```bash
for id in $(curl -s -H "Authorization: Token $TOKEN" \
              "http://localhost:8000/api/documents/?page_size=200" \
            | python3 -c "import sys,json; print(*[d['id'] for d in json.load(sys.stdin)['results']])"); do
  curl -s -X PATCH "http://localhost:8000/api/documents/$id/" \
    -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
    -d '{"tags": []}'
done
```

### Switch LLM backend or model

The backend is one setting in `docker/.env`, shared by both Node services:

```bash
LLM_BACKEND=ollama                   # or anthropic
ANTHROPIC_API_KEY=sk-ant-...         # when anthropic
ANTHROPIC_MODEL=claude-sonnet-4-6
```

Then `task start` (or `DC up -d auto-tagger aktenraum-api`) to recreate the
containers.

With Ollama, the extraction and answer models are picked in the SPA under
`/settings` and stored in the database — `OLLAMA_MODEL` is only the worker's
fallback when the api is unreachable. `OLLAMA_ANSWER_MODEL` /
`ANTHROPIC_ANSWER_MODEL` override the model for the `/ask` answer step only.
See [configuration.md](configuration.md#llm-backend).

### Backfill or rebuild the RAG index

Newly propagated docs index automatically, and on every start the worker
re-queues any propagated doc that has no chunks. For a manual pass:

```bash
bash scripts/backfill-rag-index.sh           # idempotent, skips already-indexed docs
bash scripts/backfill-rag-index.sh --force   # re-index everything
task rag:reembed                             # after changing EMBEDDING_MODEL: drop the collection + --force
```

JSON-line events on stdout (`started → doc_indexed* → completed`).

### Run the RAG eval harness

Cases live in `evals/golden-questions.yaml`, bind-mounted read-only into the
api container at `/repo/evals/`, so edits need no rebuild.

```bash
bash scripts/run-rag-eval.sh              # text report
bash scripts/run-rag-eval.sh --json       # CI-friendly JSON
```

Output: per-case rank + hit/miss + aggregate `recall@K` and `MRR`. The exit
code is 0 regardless of metrics. The committed YAML is keyed to the
maintainer's Paperless ids; copy it and re-pin against your own corpus.

### Run a manual backup

```bash
DC exec backup /usr/local/bin/entrypoint.sh
DC exec -e RESTIC_REPOSITORY=/repo backup restic snapshots --tag aktenraum
task backup:verify
```

In Git Bash prefix each `exec` with `MSYS_NO_PATHCONV=1` and write
`//usr/local/bin/entrypoint.sh`. Restore is documented in
[runbooks/restore.md](runbooks/restore.md).

### Rotate secrets

[runbooks/rotate-api-keys.md](runbooks/rotate-api-keys.md) covers the
Paperless API token, the JWT signing secret and the webhook secret. All live
in `docker/.env`; recreate the affected services afterwards
(`task start`).

---

## OpenSpec workflow

All non-trivial changes go through OpenSpec before code:

```bash
openspec new change "<name>"                   # scaffold proposal/design/specs/tasks
openspec status --change "<name>"              # what's left
openspec instructions <id> --change "<name>"   # writing guide per artifact
```

Artifacts under `openspec/changes/<name>/`: `proposal.md` (what + why),
`design.md` + `specs/` (how), `tasks.md` (execution checklist). Completed
changes are archived under `openspec/changes/archive/` and `openspec/changes/archives/`. The
`/openspec-propose` and `/opsx:apply` skills automate the scaffolding.

---

## Commit policy

From the repo's `CLAUDE.md`:

> - NEVER EVER commit anything before running tests locally.
> - NEVER EVER commit after fixing a bug without me first confirming that the bug is fixed.

"Tests" means `pnpm -r test` plus `pnpm -r lint`, and `pnpm -r build` +
both typechecks when types or the SPA changed — the same steps CI runs.

Conventional commit prefixes: `feat`, `fix`, `refactor`, `docs`, `test`,
`chore`, with scopes such as `api`, `tagger`, `web`, `core`, `compose`,
`rag`. `git log --oneline -20` is the style guide.

---

## Documentation cadence

Every working session ends with a summary at `docs/sessions/YYYY-MM-DD.md`
(what shipped, by feature, with commit hashes; a "pick up next session"
block; active roadmap progress).

- Architectural decisions → `docs/adr/NNN-name.md`
  (template at [`docs/adr/000-template.md`](adr/000-template.md))
- Multi-phase initiatives → `docs/plans/<topic>.md`
- When you change a feature, gotcha, or constraint, update `CLAUDE.md`
  in the same commit.

---

## Known gotchas

Things that have cost a debugging session at least once. Most are also in `CLAUDE.md`.

| Symptom | Cause | Fix |
|---|---|---|
| `docker compose restart` doesn't pick up a `docker/.env` change | restart reuses the container's existing env | `DC up -d <service>` to recreate |
| Source change has no effect after restart | the image still holds the old `dist/` | `DC up -d --build <service>`, or use the dev overlay |
| Compose complains `AKTENRAUM_DATA_DIR` must be set | compose was run without `--project-directory docker`, or the var is empty | run from the repo root with `DC`, and set an absolute path in `docker/.env` |
| Every API call 401s after login | `COOKIE_SECURE=true` over plain HTTP | use the Tailscale HTTPS URL; `COOKIE_SECURE=false` only for `http://localhost` |
| 401 storms from Paperless after a DB recreate | the API token is per-database | `task recover` |
| `?name=foo` on `/api/tags/` returns the first page regardless | Paperless silently ignores it | use `?name__iexact=foo` |
| Custom-field PATCH 400s on a long value | `data_type=string` has a 128-char limit | `truncateForField` at the boundary; use `longtext` (add to `LONGTEXT_FIELDS`) for fields that need more |
| `data_type=monetary` rejects `149,99 EUR` | wants `<ISO><amount>` (`EUR149.99`) | `normalizeMonetary` |
| `data_type=date` rejects `01.12.2024` | wants strict `YYYY-MM-DD` | `normalizeDate` |
| OCR fragments numbers ("28.02.24" → "2 8. 0 2.24") | Paperless OCR artefact | `SYSTEM_PROMPT` tells the LLM to recognise it — keep the rule when editing |
| Paperless picks a birthdate as `created_date` | the consumer's content-OCR date detector can't be disabled | rely on `ai_issue_date` so propagation overrides it, or set `PAPERLESS_IGNORE_DATES` |
| `data_type` can't be changed after a custom field is created | Paperless limitation | plan field types up front; recreate to migrate |
| Ollama returns `---\n{...}` or `null` for empty lists | small-model artefact | handled by `cleanJson` in `ollamaBackend.ts` and the `CoercedStrSchema` / `CoercedListSchema` preprocessors |
| `model '<name>' not found (404)` on extraction | the DB model setting names a model that isn't pulled | `ollama pull <name>` or pick another model in `/settings` |
| Long documents extracted badly on Ollama | server-default context window truncates the prompt | keep `OLLAMA_NUM_CTX` (default 24576) |
| Webhook + poller race-enqueue the same doc | both are intentional safety nets | worker re-checks lifecycle tags on dequeue; logs `skip_already_processed` |
| Same content uploaded twice is silently dropped | Paperless dedups by SHA1 | working as intended |
| `ghcr.io/paperless-ngx/tika` returns 403 | it requires auth | stay on `apache/tika` |
| Port 8080 already taken | another local stack | set `AKTENRAUM_WEB_PORT` in `docker/.env` |
| `python` vs `python3` in shell helpers | Git Bash has `python`, macOS `python3` | scripts auto-detect: `command -v python3 \|\| command -v python` |
| Restic `--last` flag is deprecated | restic CLI change | use `--latest <N>` |
