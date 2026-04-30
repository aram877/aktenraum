# Custom frontend — multi-phase roadmap

This document is the durable plan for replacing the Paperless web UI with a custom AI-first frontend. It lives outside the OpenSpec change pipeline because the work spans multiple deliveries; each phase becomes its own OpenSpec change when implementation starts.

**Status**: Phase 1 in progress (`openspec/changes/aktenraum-api-shell/`). Phase 0 done — `aktenraum-core` shared lib extracted.

---

## Goal

Replace the Paperless-ngx UI with a self-hosted SPA that puts AI front-and-centre — natural-language search, one-click summarisation, document Q&A — while delegating storage and OCR to Paperless underneath. The Paperless web UI is reserved for backend admin tasks only.

## Constraints

- Single host, Docker Compose deployment (no Kubernetes, no multi-region).
- Self-hosted, single-user today; multi-user must be a non-painful future extension.
- One command (`docker compose up -d --build`) brings up the whole stack.
- Reuse the existing LLM backend abstraction in the auto-tagger; do not rewrite it.

## Target architecture

Eight services in `docker/docker-compose.yml`:

| Service | Role | Status |
|---|---|---|
| `paperless` | DMS core, OCR, storage | existing |
| `postgres` | Paperless DB + new `aktenraum` DB | existing — new DB added in Phase 1 |
| `redis` | Paperless task queue | existing |
| `gotenberg` / `tika` | Paperless dependencies | existing |
| `auto-tagger` | Reactive extraction worker (webhook + poller + propagation) | existing — refactored in Phase 0 |
| `aktenraum-api` | FastAPI HTTP API for the SPA (auth, AI features, saved queries) | NEW — Phase 1 |
| `web` | Vite + React SPA, multi-stage built into nginx-alpine | NEW — Phase 1 |
| `nginx` | Edge: serves SPA static assets, reverse-proxies `/api/ai/*` and `/api/paperless/*` | NEW — Phase 1 |
| `backup` | Daily restic | existing |

Repo layout (post-Phase-0):

```
/
├── packages/
│   └── aktenraum-core/        # shared Python lib (LLM backends, Paperless client, models)
├── services/
│   ├── auto-tagger/           # depends on aktenraum-core
│   └── aktenraum-api/         # NEW (Phase 1) — depends on aktenraum-core
├── apps/
│   └── web/                   # NEW (Phase 1) — Vite + React + TS
├── docker/
│   ├── docker-compose.yml
│   └── nginx/                 # NEW (Phase 1)
└── ...
```

## Committed technical decisions

| Area | Choice | Why |
|---|---|---|
| Frontend | Vite + React + TypeScript | SPA, fast dev loop, no SSR needed for a localhost tool |
| UI components | shadcn/ui + Tailwind | unstyled-by-default, owned in-tree, no lock-in |
| Data fetching / routing | TanStack Query + TanStack Router | best-fit for the polling/refetch patterns lifecycle tags require |
| Backend framework | FastAPI + SQLAlchemy 2 + Alembic | Python parity with auto-tagger; async-native; auto-OpenAPI |
| Auth | Backend-for-frontend pattern: Paperless token stays server-side; SPA uses JWT in httpOnly cookie | Paperless token never reaches the browser; clean upgrade path to multi-user |
| API DB | Same Postgres container, separate logical database `aktenraum` | one container, isolated DBs; backup picks both up |
| Type contract | `openapi-typescript` generates SPA types from FastAPI's `/openapi.json` | end-to-end type safety, zero hand-maintained bindings |
| Edge | nginx (alpine) static + reverse proxy | single origin kills CORS; TLS-ready later |
| Shared Python | `packages/aktenraum-core` uv workspace member | both Python services import the same LLM/Paperless code |
| Logging | structlog JSON in both Python services | matches existing convention |

## Explicit non-goals (until evidence demands otherwise)

- Kubernetes / Helm
- Message broker (Kafka, RabbitMQ) — `asyncio.Queue` + Redis (already there) is enough
- Microservices per AI feature — `aktenraum-api` stays one service
- GraphQL — REST + OpenAPI is enough
- External auth provider (Auth0, Clerk) — local JWT for self-hosted personal
- Vector DB / RAG — only if structured-filter search hits a real ceiling
- Real-time websockets — polling is fine at personal-DMS scale

## Phasing

Each phase is its own OpenSpec change. Cross out as completed.

| Phase | OpenSpec change | Outcome |
|---|---|---|
| **0** | `extract-aktenraum-core` *(done)* | Shared `aktenraum-core` package; `auto-tagger` depends on it; uv workspace at root; tests + CI green |
| **1** | `aktenraum-api-shell` *(in progress)* | FastAPI scaffold with auth + health; SPA scaffold with login + empty layout; nginx + compose wiring; one-command deploy |
| **2** | `ai-natural-language-search` | `/api/ai/ask` endpoint + Ask AI page (NL → structured filter → Paperless search) |
| **3** | `web-inbox-review` | Two-pane review queue (PDF preview + editable AI fields + approve/reject + keyboard shortcuts) |
| **4** | `web-document-detail` | Document detail with Summary + Ask-this-doc tabs (`/api/ai/summarize`, `/api/ai/qa`) and upload |
| **5** | `web-library-and-recovery` | Library browse, errors page, saved queries |
| **6** | `ai-rag-content-search` *(speculative)* | Vector store + RAG, only if Phase 2's structured-filter search proves insufficient |
| **7** | `web-taxonomy-management` | Manage tags / correspondents / document types |

## What "Ask AI" means concretely (Phase 2 preview)

```
User types: "Lohnabrechnungen aus 2023 über 3000€"
   ↓
POST /api/ai/ask  { query: "..." }
   ↓
aktenraum-api builds prompt with closed-enum context:
  • 20 document types
  • live list of correspondents from Paperless
  • date parsing rules
   ↓
LLM returns SearchFilter JSON:
  { document_type: "Gehaltsabrechnung",
    date_from: "2023-01-01", date_to: "2023-12-31",
    min_amount: 3000 }
   ↓
aktenraum-api translates:
  • Paperless-native filters → /api/documents/?... (query string)
  • custom-field filters (e.g. min_amount on ai_total_amount) → post-filter
   ↓
Returns: { filter, results, explanation }
   ↓
SPA renders editable filter chips + result list
```

The closed-enum approach keeps the prompt small and deterministic; even gemma4 8B can handle it with a few-shot examples. RAG content search (Phase 6) layers on top only if needed.

## Cross-phase concerns (track here, not in any single phase)

- **Type generation pipeline**: `aktenraum-api` exposes `/openapi.json`; SPA build runs `openapi-typescript` against it during dev and CI. Set up once in Phase 1.
- **DB migrations**: Alembic from Phase 1. Migrations run as a one-shot init container before `aktenraum-api` starts.
- **Observability**: structlog JSON from day one. Prometheus metrics deferred until Phase 5 at earliest.
- **Backup scope**: the new `aktenraum` Postgres database is in the same container, so the existing `pg_dumpall` in `docker/backup/entrypoint.sh` already picks it up — verify in Phase 1.
- **Nginx config**: develop locally with the same nginx container the prod build uses. No "vite dev server with CORS" mode; everything goes through nginx so dev and prod paths are identical.

## When updating this doc

- Cross out a phase row when its OpenSpec change is archived.
- Update the architecture diagram if a non-trivial decision changes.
- Don't move task-level detail here — that belongs in each phase's `tasks.md`.
