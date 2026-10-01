# aktenraum

A self-hosted, privacy-preserving document management system built on [Paperless-ngx](https://docs.paperless-ngx.com/), extended with an AI classification, extraction, and retrieval layer.

Drop a PDF into the consume folder and aktenraum classifies it, summarises it in German, propagates the metadata onto Paperless's native fields once you approve it, and indexes the full body so you can later ask questions over your corpus in plain German.

**Status**: feature-complete v1 — SPA, Ask AI, review queue, library, upload, trash, RAG Phase 1 all live. Distribution work (Tauri desktop app) is in progress; see `docs/plans/desktop-app.md`.

---

## What it does

| Feature | UI | API |
|---|---|---|
| Auto-classification (27 German doc types, 12 AI custom fields) | — | auto-tagger service |
| Per-type auto-approve rules (enabled + min. confidence, off by default, "Auto-genehmigt" badge) | `/settings` | auto-tagger service + `/api/settings/*` |
| Per-correspondent history hint + few-shot exemplars from your propagated corpus | — | auto-tagger service |
| Review queue (PDF preview + editable AI fields, bulk approve, keyboard shortcuts) | `/library?tab=review`, `/inbox/<id>` | `/api/inbox/*` |
| Library / archive (filters, tag facet, URL-state, two-pane detail) | `/library` | `/api/library/*` |
| Ask AI (German prose answer with `[Quelle: <id>]` citations, SSE-streamed) | `/ask` | `/api/ai/answer/stream` |
| RAG retrieval (Qdrant + qwen3-embedding:4b + bge-reranker-v2-m3 over OCR'd document bodies) | feeds /ask | — |
| Upload (drag-and-drop, per-file progress, isolated failures) | `/upload` | `/api/documents/upload` |
| Reprocess (clear lifecycle tags + ping auto-tagger webhook) | `/library/<id>` | `/api/documents/{id}/reprocess` |
| Delete (two-step confirm, moves to Papierkorb; restore or purge there) | `/library/<id>`, `/trash` | `DELETE /api/documents/{id}`, `/api/trash/*` |
| Processing visibility (Nav badge, per-row pill, upload-page polling) | everywhere | `/api/documents/in-flight`, `/{id}/status`, `/task/{uuid}` |
| RAG eval harness (recall@K + MRR over `evals/golden-questions.yaml`) | — | `bash scripts/run-rag-eval.sh` |
| Daily restic backup (data + media + both Postgres dumps, 7/4/12 retention) | — | `backup` container |

LLM backends: **Ollama** (local, default — e.g. `qwen2.5:14b-instruct-q8_0`; the live model is picked in `/settings`) or **Anthropic** (`claude-sonnet-4-6`), selected with `LLM_BACKEND` in `docker/.env`.

---

## Architecture

Ten services, one Docker Compose file:

```
paperless        DMS core, OCR, consumer, admin UI (127.0.0.1:8000)
postgres         Hosts paperless + aktenraum databases
redis            Paperless task queue
gotenberg, tika  PDF / document parsing for Paperless
qdrant           RAG vector store (chunks + payload)
auto-tagger      AI extraction worker + RAG indexer (webhook + poller)
aktenraum-api    NestJS HTTP API: auth, AI features, RAG retrieval, document proxy
nginx            Edge: serves SPA static + reverse-proxies /api/* (127.0.0.1:8080)
backup           Daily restic backup via crond
```

Detailed walkthroughs:

- **[`docs/architecture.md`](docs/architecture.md)** — services, data flow, lifecycle, RAG pipeline
- **[`docs/architecture-diagram.md`](docs/architecture-diagram.md)** — the same stack as diagrams (Mermaid, D2, ASCII, C4) with a shared legend
- **[`docs/development.md`](docs/development.md)** — start/build/test/debug + common tasks
- **[`docs/document-types.md`](docs/document-types.md)** — the 27 German doc types + disambiguation + per-type fields
- **[`docs/configuration.md`](docs/configuration.md)** — every env var, organised by file
- **[`docs/api-reference.md`](docs/api-reference.md)** — endpoint catalog with auth + shapes
- **[`CLAUDE.md`](CLAUDE.md)** — canonical Claude working guide (dense reference)

---

## Repository layout

```
apps/web/                  Nuxt 4 SPA (ssr: false) + Vue 3 + TanStack Vue Query + Tailwind v4
packages/aktenraum-core/   @aktenraum/core — shared TypeScript lib (models, LLM backends, paperless client, RAG)
services/
  auto-tagger/             @aktenraum/worker — extraction worker + propagator + webhook + indexer
  aktenraum-api/           @aktenraum/api — NestJS HTTP API, drizzle schema, eval harness
docker/                    docker-compose.yml (+ dev / e2e overlays), .env.example, nginx + backup images
scripts/                   bootstrap, backup, RAG backfill, migrations
evals/                     RAG golden questions for the eval harness
docs/
  adr/                     Architecture Decision Records (001–008)
  plans/                   Multi-phase roadmaps (custom-frontend, desktop-app, rag-phase-1)
  runbooks/                Operational guides (first-time setup, restore, key rotation)
  sessions/                Daily session summaries (what shipped + next steps)
openspec/                  OpenSpec change proposals
```

---

## Getting started

**New machine:** install Docker Desktop, [Ollama](https://ollama.com), Git (Git Bash on Windows) and the [`task` runner](https://taskfile.dev), then:

```bash
git clone <this-repo> aktenraum
cd aktenraum
task setup        # or, without task: bash scripts/first-run.sh
```

`task setup` asks only for the data folder and does the rest (secrets, Ollama models, build, Paperless token + fields, first backup + restore check), then prints the login. It is safe to re-run. Step-by-step details: [`QUICKSTART.md`](QUICKSTART.md).

**Machine that already runs aktenraum:** after `git pull`, follow [`docs/runbooks/upgrade-existing-install.md`](docs/runbooks/upgrade-existing-install.md).

`task --list` enumerates every shortcut: `task start`, `task login`, `task web:dev`, `task build`, `task test`, `task logs SVC=auto-tagger`, etc. The SPA is at <http://localhost:8080> (override the port via `AKTENRAUM_WEB_PORT` in `docker/.env`).

For an existing corpus, run `bash scripts/backfill-rag-index.sh` to index everything into Qdrant so `/ask` can answer body-text questions.

---

## Backup

Backups run daily at 02:00 inside the `backup` container (cron-based, not systemd). Retention: 7 daily, 4 weekly, 12 monthly. Restic repo at `~/aktenraum/backup/restic-repo/`. See the **[restore runbook](docs/runbooks/restore.md)** for recovery; manual snapshot:

```bash
docker compose --project-directory docker exec backup /usr/local/bin/entrypoint.sh
# Git Bash: MSYS_NO_PATHCONV=1 and //usr/local/bin/entrypoint.sh
```

---

## Tests + CI

```bash
pnpm install                      # install all four workspace packages
pnpm -r test                      # 644 tests (core 176, api 193, worker 125, web 150)
pnpm -r lint
pnpm -r build
pnpm --filter @aktenraum/web test # one package
```

`task test` / `task lint` wrap the same commands. GitHub Actions runs one job on every push and PR: install → lint → build → typecheck → test (`.github/workflows/ci.yml`).

---

## Architecture decisions

- [ADR-001 — Monorepo tooling](docs/adr/001-monorepo-tooling.md)
- [ADR-002 — Distribution: Tauri desktop app wrapping the Compose stack](docs/adr/002-distribution-desktop-app.md)
- [ADR-007 — Node.js migration](docs/adr/007-nodejs-angular-migration.md)
- [ADR-008 — Nuxt/Vue frontend](docs/adr/008-nuxt-vue-frontend.md)
- Full list in [`docs/adr/`](docs/adr/)

Multi-phase initiatives:

- [`docs/plans/custom-frontend.md`](docs/plans/custom-frontend.md) — SPA rollout (largely complete)
- [`docs/plans/rag-phase-1.md`](docs/plans/rag-phase-1.md) — local RAG architecture + eval harness
- [`docs/plans/desktop-app.md`](docs/plans/desktop-app.md) — phased path to a shippable Tauri app

---

## What's not in v1 yet

- Tauri desktop wrapper (Phase 0 self-bootstrapping compose is the unblocker)
- Model auto-pull at install time (RAG Phase 1.11)
- Multi-user support
- Public HTTPS exposure (ports are `127.0.0.1`-bound by design; remote access goes through Tailscale, see [`docs/runbooks/tailscale-remote-access.md`](docs/runbooks/tailscale-remote-access.md))
- Prometheus metrics / health-endpoint dashboard

---

## License

See [`LICENSE`](LICENSE) if present; otherwise treat as all-rights-reserved until the project ships publicly.
