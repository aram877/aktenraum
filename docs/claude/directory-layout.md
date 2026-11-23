# Directory layout

> Moved out of CLAUDE.md to keep the always-loaded context small. Read this when working in this area.

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
│   │   │   ├── ai/ inbox/ library/ documents/ trash/ settings/ auth/ upload/ type-fields/ ingest/
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

