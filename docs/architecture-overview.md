# Aktenraum Architecture Overview

## High-level flow (single document lifecycle)

```
user uploads a document (browser /upload, consume folder, or IMAP mailbox)
        │
        ▼
┌─────────────────────┐   /api/* proxy   ┌──────────────────┐  post_document  ┌──────────────────┐
│  nginx :8080        │ ───────────────► │  aktenraum-api   │ ──────────────► │  Paperless-ngx   │
│  SPA static + API   │                  │  :8002 (NestJS)  │                 │  port :8000      │
│  proxy /api/* →     │                  │  Paperless token │                 │  OCR, storage,   │
│  aktenraum-api:8002 │                  │  stays here      │                 │ metadata catalog │
└─────────────────────┘                  └──────────────────┘                 └────────┬─────────┘
                                                                                       │
                                                ┌──────────────────────────────────────┘
                                                │ document stored
                                                │ + text extracted via
                                                │   Tika (Office/email parsing), Gotenberg (Office → PDF),
                                                │   and the built-in OCR engine
                                                ▼
                                          ┌───────────┐
                                          │ auto-     │
                                          │ tagger    │←── receives paperless post_consume webhook
                                          │  worker   │    (+ 30s poller safety net)
                                          └─────┬─────┘
                                                │ pass 1: doc type, date, sender, title, reference numbers,
                                                │         summary, confidence → 12 ai_* fields in Paperless
                                                │ pass 2: type-specific fields (e.g. Rechnung amount)
                                                │         → aktenraum DB via aktenraum-api
                                                ▼
                                        ┌──────────────────┐ ───► ai-approved? → native metadata fields written to Paperless
                                        │ postgres          │      → chunks embedded into Qdrant
                                        │ (paperless +     │
                                        │  aktenraum DBs)  │
                                        └──────────────────┘

If user asks a question:
/ask page → POST /api/ai/answer/stream: "what did i pay for the car last month"
        │
        ▼
LLM extracts a structured filter → Paperless search; in parallel the RAG pipeline embeds the
question (qwen3-embedding:4b), finds relevant chunks in Qdrant by cosine similarity, reranks
them with bge-reranker-v2-m3
        │
        ▼
LLM gets retrieved context + user question as prompt → streams a German answer with citations over SSE.
```

## 10 Services in the Stack

| Service | Role | Port (external) | Notes for interviewers |
|---------|------|------------------|------------------------|
| **nginx** | Edge: serves the statically generated Nuxt SPA, reverse-proxies `/api/*` → `aktenraum-api`. | 8080 (configurable via `AKTENRAUM_WEB_PORT`) | Single point of traffic; the Paperless API token never reaches the browser |
| **Paperless-ngx (`ghcr.io/paperless-ngx/paperless-ngx:2.20.15`)** | The *content store* — handles parse/OCR, native metadata model (correspondent, document_type, tags), media storage, uses Gotenberg for Office → PDF conversion. | 8000 (localhost only) | Domain-driven DMS with solid open-source community; not a generic blobstore. Pinned by tag + digest so behavior is deterministic across users & CI |
| **Postgres (`postgres:15`)** | Hosts `paperless` DB + `aktenraum` DB | internal-only | Paperless owns its schema; the `aktenraum` database holds SPA users, app settings (live LLM models), per-type auto-approve rules and the pass-2 type-specific fields. The `ai_*` metadata itself lives in Paperless custom fields. Both databases are dumped separately in the backup flow |
| **Redis (`redis:7`)** | Message broker / cache layer | internal-only | Used for async task queues within Paperless-ngx. Pinned to the 7.x tag for behavior stability |
| **Gotenberg (`gotenberg/gotenberg:8.31.0`)** | PDF conversion service | internal-only | Converts Office documents → PDF for Paperless; doesn't do OCR. Pinned by tag + digest because a floating `:8` silently tracks any 8.x release. |
| **Tika (`apache/tika:latest`, digest-pinned)** | Document parsing microservice | internal-only (9998) | Extracts text from Office documents and emails for Paperless. Digest-pinned because its tag scheme is ambiguous. Uses `apache/tika` because `ghcr.io/paperless-ngx/tika` requires auth. |
| **Qdrant (`qdrant/qdrant:v1.17.1`)** | Vector store for RAG retrieval | 6333 (REST, localhost only) & 6334 (gRPC, internal) | Dense vectors only (2560-dim, cosine distance). The `aktenraum_chunks` collection holds chunk embeddings; payload indexes on `doc_id`, `doc_type`, `correspondent` and `tags` keep query-time payload filters fast. |
| **auto-tagger (local build, Node 22)** | AI classification pipeline: webhook receiver → in-memory `AsyncQueue` worker (with poller safety net) that fetches document content via the Paperless REST API → calls the configured LLM backend (Ollama model resolved from `aktenraum-api`, `OLLAMA_MODEL` fallback if the api is unreachable) → validates via zod + applies lifecycle tags → runs a second, type-specific extraction pass. Also owns propagation and RAG indexing. | 8001 (internal webhook only, never published to the host) | Five concurrent loops (extraction worker, extraction poller every 30s, propagation worker, propagation poller, indexer fed by propagation) plus the HTTP webhook server. Queues are process-local, so there are no distributed-commit headaches; on restart the poller and an index reconcile pass re-discover outstanding work. |
| **aktenraum-api (local build, Node 22)** | NestJS (ESM) layer: HTTP routes for the SPA; JWT auth with HS256 cookies (httpOnly, SameSite=Lax); CSRF middleware; bootstrap-first-run user. Exposes the Ask endpoint (`POST /api/ai/answer/stream`, SSE), inbox, library, upload, trash, settings and internal secret-gated endpoints for the worker. | 8002 (internal API only; exposed to nginx) | Runs `node dist/main.js`; config comes from `docker/.env` via environment variables. Startup applies `schema.sql` (`applySchema()`) before Nest boots, seeds the bootstrap user, reconciles auto-approve rules, and pre-warms the reranker model in the background so the first `/ask` after a rebuild isn't blocked on the model download. |
| **backup (local build)** | Daily restic snapshots of `data`, `media`, `export` under `AKTENRAUM_DATA_DIR` + two PostgreSQL dumps (`postgres.dump` for `paperless`, `aktenraum.dump` for `aktenraum`) into the restic repository at `$AKTENRAUM_DATA_DIR/backup/restic-repo`. 7-daily / 4-weekly / 12-monthly retention policy. The repo is initialised once by `task setup`; the entrypoint fails loudly if it is missing unless `BACKUP_AUTO_INIT=true`. | internal-only (`entrypoint.sh` fires via crond at 02:00) | Restic chosen over plain `rsync --backup-dir=...` because of dedup + compression + encryption, plus cross-host restore compatibility. |

## 2. Data flow patterns worth mentioning in interview  

### **Event-driven AI classification with safety nets**
- A `post_consume_script` in Paperless fires a webhook to `auto-tagger:8001/trigger/extract` when documents land.  
- But there's also a polling fallback (the `poller` loop in `services/auto-tagger/src/main.ts`, every `POLL_INTERVAL_SECONDS` = 30s, calls `PaperlessClient.getUnprocessedDocuments` to find docs without lifecycle tags). This hybrid approach handles network blips, restarts, and Paperless-side failures gracefully. Interview-relevant: *fail-closed by default — unclassifiable documents remain pending rather than being dropped silently*.

### **Async queue with retry semantics**
- An in-memory `AsyncQueue<number>` holds document IDs to classify; the polling loop enqueues safety-net additions while the webhook receiver handles the primary path.  
- Worker drains in order (FIFO). A transient LLM failure (connection refused, timeout, 429/5xx) leaves the doc untagged so the poller retries it; the third transient failure tags it `ai-error` with a human-readable German reason. Non-transient failures tag `ai-error` immediately — no infinite retry loops silently degrading CPU.

### **Deterministic image pinning**
External images are pinned in `docker/docker-compose.yml`: Paperless, Gotenberg and Tika by tag AND SHA256 digest, Qdrant by exact version tag (`v1.17.1`), Postgres and Redis by major tag. Interview worth mentioning: "I don't trust `latest`. Version drift breaks OCR behavior in Tika, changes API contracts between Qdrant releases, silently shifts Redis eviction policies."

### **LLM backend selection and model resolution**
The system supports both Ollama (local classification and embeddings for privacy) and Anthropic Claude, selected per deploy with `LLM_BACKEND=ollama|anthropic`. With Ollama, the live model is the one picked in `/settings` (stored in `app_settings`); the worker fetches it from `aktenraum-api` with a 60s cache, keeps the last good value on a blip, and falls back to `OLLAMA_MODEL` only if the api is unreachable at a cold start. Interview value: *deals gracefully with intermittent service failure*.

### **Backup integrity verification**
`restic check --read-data-subset=5%` runs in the backup container on Sundays (not just the daily snapshot). `task backup:verify` also does a real filesystem restore to a throwaway staging directory and confirms both DB dumps are present and look like valid `pg_dump` output. *Don't trust — verify*.

## 3. Technical decisions / trade-offs worth mentioning in interview  

### **Why split auto-tagger from aktenraum-api?**
- Isolated failure domain: if extraction hits a malformed prompt or a stuck LLM call, only the worker is affected; the API keeps serving HTTP.  
- Independent memory & CPU caps — the API loads the in-process reranker model and serves I/O-bound HTTP, while the worker runs long LLM and embedding calls.  
- Rebuild/restart cadence is independent — SPA and API changes don't restart the classification pipeline (see ADR-004; the rationale carried over unchanged to the Node stack).

### **Why local Ollama + Anthropic combo?**
- Local first: users uploading sensitive docs (medical records, contracts) prefer their data stays on device for privacy / GDPR compliance concerns.  
- Claude as an alternative backend because some extractions need high-complexity reasoning (long financial reports); small local models would hallucinate or drop fields silently.

### **Why not just use Paperless's built-in tagging?**
Paperless has simple rule-based tag assignment, but aktenraum needs:
1. Multi-field structured extraction (date + amount + vendor + legal terms).  
2. Confidence-based routing — auto-approve low-risk documents so operator doesn't triage everything.  
3. RAG context-aware answers ("what did I pay for car last month" requires semantic retrieval across years of OCR'd text, not keyword search inside a single doc).

## Interview-style summary (say out loud)

> "I built `aktenraum`, a self-hosted personal document management system that wraps Paperless-ngx with an AI layer for German-language invoice and contract classification. The stack runs entirely in Docker and uses Ollama (with local models) or Anthropic Claude as the LLM backend — whichever's configured per deploy. The active Ollama model is a runtime setting, with an env-var fallback if the API is unreachable, so documents don't get stuck in limbo.
> 
> The application code is TypeScript end to end in one pnpm workspace. I split two Node services: `aktenraum-api` is a NestJS API that handles SPA auth, the streaming Ask endpoint, inbox and library routes, and is exposed through nginx as an edge server proxying `/api/*`; nginx also serves the statically generated Nuxt SPA. The second service, `auto-tagger`, owns the event-driven pipeline — it receives webhooks from Paperless's `post_consume_script`, runs documents through a zod-validated LLM extraction against either Ollama or Anthropic, then a second type-specific pass, and applies lifecycle tags so unclassified docs always remain visible for human review.
> 
> The data layer is one Postgres instance with two databases — Paperless's own and an `aktenraum` database for users, settings, auto-approve rules and type-specific fields — Redis for async task queues within Paperless, and Qdrant as a dense vector store for the RAG pipeline, with payload indexes on document type, correspondent and tags so query-time filters stay fast.
> 
> External images are pinned by tag, most of them also by SHA256 digest. The backup service runs restic daily against the Paperless data, media and export directories plus two live Postgres dumps into a deduplicated, encrypted repository, with 7-daily / 4-weekly / 12-monthly retention; `task backup:verify` even does a real filesystem restore check, so I actually *trust* the backups."

## Want me to go deeper on any specific part?

For example:
- **The RAG pipeline internals** (chunking strategy + embedding retrieval → reranking flow)
- **The Paperless webhook integration** and why hybrid approach with poller fallback is better than pure event-driven
- **Backup verification logic** (`restic check` vs actual restore test in `task backup:verify`)
- **Auth flow**: how JWT cookies work, httpOnly + SameSite=Lax reasoning
