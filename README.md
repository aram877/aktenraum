# aktenraum

A self-hosted, privacy-preserving document management system built on [Paperless-ngx](https://docs.paperless-ngx.com/), extended with an AI classification, extraction, and retrieval layer.

Drop a PDF into the consume folder and aktenraum classifies it, summarises it in German, propagates the metadata onto Paperless's native fields once you approve it, and indexes the full body so you can later ask questions over your corpus in plain German.

**Status**: feature-complete v1 — SPA, AI find + ask, inbox review, library, upload, RAG Phase 1 all live. Distribution work (Tauri desktop app) is in progress; see `docs/plans/desktop-app.md`.

---

## What it does

| Feature | UI | API |
|---|---|---|
| Auto-classification (20 German doc types, 11 AI custom fields) | — | auto-tagger service |
| Confidence-based auto-approve (≥ 90 %, any type, with "Auto-genehmigt" badge) | — | auto-tagger service |
| Per-correspondent history hint + few-shot exemplars from your propagated corpus | — | auto-tagger service |
| Inbox review queue (PDF preview + editable AI fields, keyboard shortcuts) | `/inbox` | `/api/inbox/*` |
| Library / archive (filters, tag facet, URL-state, two-pane detail) | `/library` | `/api/library/*` |
| Find docs (closed-enum SearchFilter, editable chips, German LLM extraction) | `/find` | `/api/ai/find` |
| Ask AI (German prose answer with `[Quelle: <id>]` citations, SSE-streamed) | `/ask` | `/api/ai/answer/stream` |
| RAG retrieval (Qdrant + bge-m3 + bge-reranker-v2-m3 over OCR'd document bodies) | feeds /ask | — |
| Upload (drag-and-drop, per-file progress, isolated failures) | `/upload` | `/api/documents/upload` |
| Reprocess (clear lifecycle tags + ping auto-tagger webhook) | preview modal | `/api/documents/{id}/reprocess` |
| Delete (two-step confirm, invalidates all caches) | preview modal + library detail | `DELETE /api/documents/{id}` |
| Processing visibility (Nav badge, per-row pill, upload-page polling) | everywhere | `/api/documents/in-flight`, `/{id}/status`, `/task/{uuid}` |
| RAG eval harness (recall@K + MRR over `evals/golden-questions.yaml`) | — | `python -m aktenraum_api.eval.runner` |
| Daily restic backup (data + media + Postgres dump, 7/4/12 retention) | — | `backup` container |

LLM backends: **Ollama** (local, default — `gemma4` and friends) or **Anthropic** (`claude-sonnet-4-6`).

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
aktenraum-api    FastAPI HTTP API: auth, AI features, RAG retrieval, document proxy
nginx            Edge: serves SPA static + reverse-proxies /api/* (127.0.0.1:8080)
backup           Daily restic backup via crond
```

Detailed walkthroughs:

- **[`docs/architecture.md`](docs/architecture.md)** — services, data flow, lifecycle, RAG pipeline
- **[`docs/architecture-diagram.md`](docs/architecture-diagram.md)** — the same stack as diagrams (Mermaid, D2, ASCII, C4) with a shared legend
- **[`docs/development.md`](docs/development.md)** — start/build/test/debug + common tasks
- **[`docs/document-types.md`](docs/document-types.md)** — the 26 German doc types + disambiguation + per-type fields
- **[`docs/configuration.md`](docs/configuration.md)** — every env var, organised by file
- **[`docs/api-reference.md`](docs/api-reference.md)** — endpoint catalog with auth + shapes
- **[`CLAUDE.md`](CLAUDE.md)** — canonical Claude working guide (dense reference)

---

## Repository layout

```
apps/web/                  React 19 + Vite + TanStack Router/Query + Tailwind v4 SPA
packages/aktenraum-core/   Shared Python lib (models, LLM backends, paperless client, RAG)
services/
  auto-tagger/             Extraction worker + propagator + webhook + indexer
  aktenraum-api/           FastAPI HTTP API, Alembic migrations, eval harness
docker/                    docker-compose.yml + per-service env templates + nginx config
scripts/                   bootstrap, backup, RAG backfill, migrations
evals/                     RAG golden questions for the eval harness
docs/
  adr/                     Architecture Decision Records (001 tooling, 002 desktop-app)
  plans/                   Multi-phase roadmaps (custom-frontend, desktop-app, rag-phase-1)
  runbooks/                Operational guides (first-time setup, restore, key rotation)
  sessions/                Daily session summaries (what shipped + next steps)
openspec/                  OpenSpec change proposals
```

---

## Getting started

See the **[First-time setup runbook](docs/runbooks/first-time-setup.md)** for the full step-by-step.

Quick version (using the [`task` runner](https://taskfile.dev) — `brew install go-task`):

```bash
git clone <this-repo>
cd aktenraum
task bootstrap                       # host dirs + secrets + stack up + next-step hints
```

Or without `task`:

```bash
bash scripts/setup.sh                # create ~/aktenraum/ host dirs
bash scripts/bootstrap-secrets.sh    # generate runtime secrets in docker/*.env
cd docker && docker compose up -d
```

`task --list` enumerates every shortcut: `task up`, `task web:dev`,
`task api:rebuild`, `task test`, `task logs SVC=auto-tagger`, etc.

After the first boot, mint a Paperless API token and run `bash scripts/bootstrap-paperless.sh` to create the AI custom fields and lifecycle tags. The SPA is at <http://localhost:8080> (override the port via `AKTENRAUM_WEB_PORT` in `docker/.env`).

For an existing corpus, run `bash scripts/backfill-rag-index.sh` to index everything into Qdrant so `/ask` can answer body-text questions.

---

## Backup

Backups run daily at 02:00 inside the `backup` container (cron-based, not systemd). Retention: 7 daily, 4 weekly, 12 monthly. Restic repo at `~/aktenraum/backup/restic-repo/`. See the **[restore runbook](docs/runbooks/restore.md)** for recovery; manual snapshot:

```bash
MSYS_NO_PATHCONV=1 docker compose exec backup //usr/local/bin/entrypoint.sh
```

---

## Tests + CI

```bash
uv sync                      # install Python deps for both workspace members
uv run pytest                # 419 tests, ~50s
uv run ruff check
pnpm install
pnpm --filter @aktenraum/web lint
pnpm --filter @aktenraum/web build
```

GitHub Actions runs the Python and web jobs on every push and PR (`.github/workflows/ci.yml`).

---

## Architecture decisions

- [ADR-001 — Monorepo tooling](docs/adr/001-monorepo-tooling.md)
- [ADR-002 — Distribution: Tauri desktop app wrapping the Compose stack](docs/adr/002-distribution-desktop-app.md)

Multi-phase initiatives:

- [`docs/plans/custom-frontend.md`](docs/plans/custom-frontend.md) — SPA rollout (largely complete)
- [`docs/plans/rag-phase-1.md`](docs/plans/rag-phase-1.md) — local RAG architecture + eval harness
- [`docs/plans/desktop-app.md`](docs/plans/desktop-app.md) — phased path to a shippable Tauri app

---

## What's not in v1 yet

- Tauri desktop wrapper (Phase 0 self-bootstrapping compose is the unblocker)
- Model auto-pull at install time (RAG Phase 1.11)
- Multi-user support
- HTTPS / Tailscale exposure (currently `127.0.0.1`-bound by design)
- Backup integrity checks (`restic check`) on a schedule
- Prometheus metrics / health-endpoint dashboard

---

## License

See [`LICENSE`](LICENSE) if present; otherwise treat as all-rights-reserved until the project ships publicly.
