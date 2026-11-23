# aktenraum — Claude working guide

Self-hosted personal DMS built on Paperless-ngx with an AI classification layer. Everything runs in Docker. The application code is TypeScript end to end — NestJS API, Node worker, Nuxt/Vue SPA, one shared library — in a single pnpm workspace. Scripts target bash and run on macOS, Linux, or Windows (Git Bash). Deployment target is Docker Desktop or native Linux Docker.

**Upgrading a machine that already runs aktenraum?** Follow [`docs/runbooks/upgrade-existing-install.md`](docs/runbooks/upgrade-existing-install.md) step by step — it is written for a Claude session to execute (commands, expected output, what to do on failure). Use it after every `git pull` on a deployed host.

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
- [`docs/plans/backlog.md`](docs/plans/backlog.md) — small follow-ups parked for later (not yet OpenSpec changes)

---

## Skills (auto-invoked from `.claude/skills/<name>/SKILL.md`)

`paperless-api-integration` (PaperlessClient/Gateway), `llm-extraction-fallbacks` (prompt/extract/synthesizers), `aktenraum-commit-discipline` (before any commit), `nestjs-route-pattern` (api controllers), `lifecycle-tag-state-machine` (lifecycle tags), `spa-data-fetching` (apps/web). Invoke explicitly with `/<skill-name>` if unsure.

---

## Stack (10 services — all in `docker/docker-compose.yml`)

Two Node services (`auto-tagger` for background work, `aktenraum-api` for HTTP) is a deliberate split — see [`docs/adr/004-two-python-services.md`](docs/adr/004-two-python-services.md) for the rationale (process isolation, independent memory caps, independent restart cadence). The rationale survived the TypeScript migration unchanged; only the runtime differs.

Every external image is pinned by tag-and-digest — the compose services in `docker/docker-compose.yml` and the Dockerfile bases (`node:22-slim`, `node:22-alpine`, `nginx:alpine`, `alpine:3.20`). Installs use `pnpm install --frozen-lockfile` in CI and every Dockerfile. Bump with intent: `docker buildx imagetools inspect <image:tag>` gives the current digest; never bump Qdrant more than one minor at a time, and keep `@qdrant/js-client-rest` on the same minor (`~1.17.0` today).

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


## Essential commands

`task start` / `stop` / `status` · `task build` (rebuild images + restart changed) · `task test` / `task lint` · `task logs SVC=<name>` · `task web:dev`. Run everything from the repo root (pnpm workspace). Full list, raw docker commands, backup commands: [`docs/claude/commands.md`](docs/claude/commands.md).

## Always-true gotchas (one-liners; details in `docs/claude/gotchas.md`)

- Set `AKTENRAUM_DATA_DIR` explicitly in `docker/.env` on Windows (unset → silent data loss). Never change it without migrating data.
- `docker compose restart` does NOT re-read env or code: use `up -d` (`--build` after source changes, or `task build`).
- Git Bash mangles `/usr/...` paths in `docker exec`: prefix `MSYS_NO_PATHCONV=1` and use `//usr/...`.
- Paperless: `?name=` is ignored (use `?name__iexact=`); `custom_fields` PATCH replaces the whole array; string fields cap at 128 chars. See `docs/claude/paperless.md`.
- The live LLM model is the DB setting in `/settings`, not `OLLAMA_MODEL`.
- New api route: needs `@RequireScope`, and is closed to restricted sessions / tokens unless marked; `test/route-inventory.test.ts` pins this.
- New DB table: add to BOTH `schema.ts` and `schema.sql`. pg-mem rejects correlated subqueries: use `IN (SELECT …)`.
- Don't rebuild/touch the live stack or live data without asking.

## Reference docs for Claude (read on demand — not loaded automatically)

| Working on… | Read |
| --- | --- |
| Commands, raw docker, backup CLI | [`docs/claude/commands.md`](docs/claude/commands.md) |
| Env vars, secrets, tokens, passkeys config | [`docs/claude/credentials.md`](docs/claude/credentials.md) |
| Paperless API calls, normalisers, LLM→Paperless validation | [`docs/claude/paperless.md`](docs/claude/paperless.md) |
| Repo layout | [`docs/claude/directory-layout.md`](docs/claude/directory-layout.md) |
| Worker: extraction, lifecycle tags, routing, propagation, doc taxonomy | [`docs/claude/auto-tagger.md`](docs/claude/auto-tagger.md) |
| Ask / RAG indexing / eval | [`docs/claude/ai-pipeline.md`](docs/claude/ai-pipeline.md) |
| aktenraum-api: auth, tenancy, shares, library, inbox, upload | [`docs/claude/api-notes.md`](docs/claude/api-notes.md) |
| Backup | [`docs/claude/backup.md`](docs/claude/backup.md) |
| Any bug / odd behaviour (check here first) | [`docs/claude/gotchas.md`](docs/claude/gotchas.md) |
| What exists / is planned | [`docs/claude/feature-status.md`](docs/claude/feature-status.md) |
| OpenSpec flow, archived changes | [`docs/claude/openspec-history.md`](docs/claude/openspec-history.md) |
| Build, test counts, CI, dev overlay | [`docs/claude/development.md`](docs/claude/development.md) |

## Binding project rules

**Distribution direction (binding)**: aktenraum is being built for sale as a Tauri desktop app wrapping the Docker Compose stack — not as a Docker tarball. See `docs/adr/002-distribution-desktop-app.md` for the constraints this places on every change (no committed secrets, configurable data dir, idempotent first-run, model auto-pull, etc.) and `docs/plans/desktop-app.md` for the phased roadmap. **Phase 0 — self-bootstrapping compose — is the unblocker; nothing Tauri-specific lands until Phase 0 is done.** **Currently deferred per [ADR-005](docs/adr/005-test-phase-access-via-tailscale.md): during the testing phase the maintainer validates the product via Tailscale-mediated remote access (`docs/runbooks/tailscale-remote-access.md`); Phase 0 resumes when the milestones listed in ADR-005 are met.**

**RAG direction (binding)**: the answer pipeline is being upgraded to production-grade local retrieval — Qdrant + Qwen3-Embedding-4B (dense, 2560-dim; migrated off bge-m3 2026-06-22) + bge-reranker-v2-m3 (transformers.js, in-process), with Ollama for embeddings; sparse/hybrid retrieval is planned but not built. See `docs/plans/rag-phase-1.md` for the architecture, schema, sub-phasing (1.1–1.12), and the eval harness that gates merges. `/api/ai/answer/stream` combines AI metadata with reranked chunks of the full OCR text, so questions whose answers live in the document body (CV employment durations, contract clauses, etc.) work.

**Documentation cadence (binding)**: every working session ends with a session summary at `docs/sessions/YYYY-MM-DD.md` listing what shipped, by feature, with commit hashes; a "things to pick up next session" block; and the active roadmap progress for any plan in `docs/plans/`. Architectural decisions go to `docs/adr/NNN-name.md` (template at `docs/adr/000-template.md`). Multi-phase initiatives go to `docs/plans/<topic>.md`. Whenever a session changes any of these (new feature, new gotcha, new constraint, finished phase), CLAUDE.md is updated in the same commit so future sessions see current state without trawling git log.

When a session adds a feature, gotcha, constraint or finishes a phase, update the matching `docs/claude/*.md` file (and this file only if the change is an always-true rule) in the same commit.

OpenSpec: non-trivial changes go through `/openspec-propose` → `/opsx:apply` (details in `docs/claude/openspec-history.md`).

## COMMIT AND PUSH RULES

- NEVER EVER commit anything before running tests locally..
- NEVER EVER commit after fixing a bug without me first confirming that the bug is fixed
