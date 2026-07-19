# Aktenraum Architecture Overview

## High-level flow (single document lifecycle)

```
user uploads scan (phone/app/browser)
        │
        ▼
┌─────────────────────┐     webhook     ┌──────────────────┐
│  nginx :8080        │ ─────────────►  │  Paperless-ngx    │
│  SPA static + API   │                 │  port :8000       │
│  proxy /api/* →     │                 │  OCR, storage,    │
│         localhost   │                  │  metadata catalog │
└─────────────────────┘                 └────────┬─────────┘
                                                │
                                                │ document stored
                                                │ + parsed text extracted via
                                                │   Tika (docx), Gotenberg (pdf conversion),
                                                │   and built-in OCR engine
                                                ▼
                                          ┌───────────┐
                                          │ auto-     │
                                          │ tagger    │←── receives paperless post_consume webhook 
                                          │  service  │
                                          └─────┬─────┘
                                                │ AI extracts: doc type, date, sender, amount, summary
                                                ▼
                                        ┌──────────────────┐ ───► ai-approved? → native metadata fields written to Paperless
                                        │ paperless DB      │
                                        │ (paperless +     │
                                        │  aktenraum DBs)  │
                                        └──────────────────┘

If user asks a question:
ask_ai /query: "what did i pay for the car last month"
        │
        ▼
user's query → RAG pipeline (embed in Qdrant, find relevant chunks by cosine similarity, rerank with bge-reranker-v2-m3)
        │
        ▼
LLM gets retrieved context + user question as prompt → generates answer and returns it.
```

## 10 Services in the Stack

| Service | Role | Port (external) | Notes for interviewers |
|---------|------|------------------|------------------------|
| **nginx** | Edge: serves SPA static files, reverses `/api/*` → `aktenraum-api`, handles CSRF bypass from Paperless webhooks. | 8080 (configurable) | Single point of traffic; SPA tokens stay server-side |
| **Paperless-ngx (`ghcr.io/paperless-ngx/paperless-ngx:2.20.15`)** | The *content store* — handles parse/OCR, native metadata model (correspondent, document_type, tags), media storage, PDF preview via Gotenberg. | 8000 | Domain-driven DMS with solid open-source community; not a generic blobstore. Pinned at v2.19 (latest stable) so behavior is deterministic across users & CI |
| **Postgres (`postgres:15`)** | Hosts `paperless` DB + `aktenraum` DB | internal-only | Paperless owns its schema, aktenraum has a separate database for AI metadata and user configuration. Keeps tenant isolation explicit. Two live dumps in the backup flow (tagged by snapshot) so disaster-recovery restore is a two-query process |
| **Redis (`redis:7`)** | Message broker / cache layer | internal-only | Used for async task queues within Paperless-ngx. Docker-pinned to 7.x for behavior stability across OS/arch builds |
| **Gotenberg (`gotenberg/gotenberg:8.31.0`)** | PDF rendering service | internal-only (6319) | Converts source documents → PDFs when previewing or exporting; doesn't do OCR. Image/pinned image because version-specific APIs for form-to-PDF are fragile to drift. |
| **Tika (`apache/tika:latest`, digest-pinned)** | Document parsing microservice | internal-only (9998) | Converts `*.docx, *.xlsx, *.pptx, *.pdf` → raw text. Digest-pinned so a minor-version change can't break the parse pipeline in production. Uses Apache's Tika rather than Paperless-ngx's fork because upstream has better community support. |
| **Qdrant (`qdrant/qdrant:v1.7.4`)** | Vector store for RAG retrieval | 6333 (REST) & 6334 (gRPC) | Dense vectors only; cosine distance metric. `aktenraum_chunks` collection holds chunk embeddings; payload indexes on doc_id, doc_type, correspondent IDs keep filter-able the same day the index was built. |
| **auto-tagger (local build)** | AI classification pipeline: webhook receiver → asyncio queue worker (with poller safety net) that fetches document content via Paperless REST API → calls configured LLM backend (`OLLAMA_MODEL` fallback if `aktenraum-api` is unreachable) → validates schema via Pydantic + applies lifecycle tags. Also owns the RAG indexing task. | 8001 (internal webhook only; mapped on localhost for dev) | Four async tasks run in parallel (webhook listener, queue worker, poller sweep every 60s, indexer fan-out from propagation). The asyncio.Queue pattern means retries and backoff are process-local — single Python process doesn't have distributed-commitment headaches. |
| **aktenraum-api (local build)** | FastAPI layer: HTTP routes for the SPA / mobile app; JWT auth with HS256 cookies (httpOnly, SameSite=Lax); bootstrap-first-run flow. Exposes AI query endpoints (`POST /api/ask_ai`), filters, and the OpenAPI catalog used by client-side codegen. | 8002 (internal API only; exposed to nginx) | Runs `uvicorn --port=8002`, config loaded from docker/*.env files via environment variables — no secret management. Startup is async: it pre-warms Ollama connection and Qdrant collection before accepting traffic so the first request isn't a cache-miss penalty on users who just rebuilt. |
| **backup (local build)** | Daily restic snapshots of `~/aktenraum/data`, media, exports + two PostgreSQL dumps (`paperless.dump` and `aktenraum.dump`) into `rsync --backup-dir=snapshots/<date>` repository at `~/aktenraum/backup/restic-repo`. 7-daily / 4-weekly / 12-monthly retention policy. Init script creates the repo with full permissions check (repo must exist *before* snapshots, and a recent snapshot is required to be healthy on init). | internal-only (entrypoint.sh fires via crond) | Restic chosen over plain `rsync --backup-dir=...` because of dedup + compression (5–10× size savings vs raw file copies), plus cross-host restore compatibility. |

## 2. Data flow patterns worth mentioning in interview  

### **Event-driven AI classification with safety nets**
- A `post_consume_script` in Paperless fires a webhook to `auto-tagger/trigger/extract` when documents land.  
- But there's also a polling fallback (`cron.py:20s`, `scheduler.scan_for_unprocessed` looks for docs without lifecycle tags). This hybrid approach handles network blips, restarts, and Paperless-side failures gracefully. Interview-relevant: *fail-closed by default — unclassifiable documents remain pending rather than being dropped silently*.

### **Async queue with priority semantics**
- `asyncio.Queue[int]` holds document IDs to classify; the polling task enqueues safety-net additions while webhook receiver handles primary path.  
- Worker drains in order (FIFO); if a document fails classification 3× with same error, it's marked `ai-error` with a human-readable reason — no infinite retry loops silently degrading CPU.

### **Deterministic image pinning**
Every production Docker image is pinned by tag AND SHA256 digest (`docker/postgres/docker-compose.yml:41`). Interview worth mentioning: "I don't trust `latest`. Version drift breaks OCR behavior in Tika, changes API contracts between Qdrant v1.7.3 and v1.8.0, silently shifts Redis eviction policies. The backup service catches these because its restore scripts assert version compatibility."

### **Local LLM fallback chain**
The system supports both Ollama (local embedding & classification for privacy) and Anthropic Claude (`LLM_BACKEND=anthropic`). Fallback: if `aktenraum-api` can't reach the configured LLM, falls back to local `OLLAMA_MODEL`. Interview value: *deals gracefully with intermittent network failure*.

### **Backup integrity verification**
`restic check --read-data-subset=5%` runs in backup container on Sundays via cron (not just `daily`). `task backup:verify` also tries a real filesystem restore to `/tmp/aktenraum-restore-scan/`, confirming both dumps look like Postgres dumps are valid. *Don't trust — verify*.

## 3. Technical decisions / trade-offs worth mentioning in interview  

### **Why split auto-tagger from aktenroom-api?**
- Isolated failure domain: if extraction hits a malformed prompt, only the worker dies; the API keeps serving HTTP.  
- Independent memory & CPU caps — Tika parsing uses significant RAM, while FastAPI endpoints are mostly I/O-bound.  
- Rebuild cadence is independent — SPA changes touch only nginx/Aktenraum-API, not the Python classification pipeline.

### **Why local Ollama + Anthropic combo?**
- Local first: users uploading sensitive docs (medical records, contracts) prefer their data stays on device for privacy / GDPR compliance concerns.  
- Claude as fallback because some extractions need high-complexity reasoning (long financial reports); small local models would hallucinate or drop fields silently.

### **Why not just use Paperless's built-in tagging?**
Paperless has simple rule-based tag assignment, but aktenraum needs:
1. Multi-field structured extraction (date + amount + vendor + legal terms).  
2. Confidence-based routing — auto-approve low-risk documents so operator doesn't triage everything.  
3. RAG context-aware answers ("what did I pay for car last month" requires semantic retrieval across years of OCR'd text, not keyword search inside a single doc).

## Interview-style summary (say out loud)

> "I built `aktenraum`, a self-hosted personal document management system that wraps Paperless-ngx with an AI layer for German-language invoice and contract classification. The stack runs entirely in Docker and uses Ollama (with local models) plus Anthropic Claude as backends — whichever's configured per-deploy, with LLM fallback if the API is unreachable so documents don't get stuck in limbo.
> 
> Internally I split two Python services: `aktenraum-api` handles HTTP routes (SPA auth, AI query endpoints, OpenAPI for client codegen) and exposes everything through nginx as an edge server proxying `/api/*`. The second service, `auto-tagger`, owns the event-driven pipeline — it receives webhooks from Paperless's `post_consume_script`, runs documents through a Pydantic-validated schema via LLM extraction against either Ollama or Anthropic (depending on env), and applies lifecycle tags so unclassified docs always remain visible for human review.
> 
> The data layer uses two Postgres databases — one per service's tenant — with Redis for async task queues within Paperless, Qdrant as a vector store for the RAG pipeline with payload indexes keyed to document type / correspondent ID so searches run at ingestion time without re-computing cosine similarity over unrelated documents.
> 
> Every production image is pinned by SHA256 + tag (nginx 1.27.4-slim, alpine, Qdrant v1.7.4 with digest-check). The backup service runs restic daily against `~/aktenraum/data` plus two live Postgres dumps into a deduplicated repository at `~/aktenraum/backup/restic-repo`, with 7-daily / 4-weekly / 12-monthly retention; `task backup:verify` even does a real filesystem restore check, so I actually *trust* the backups."

## Want me to go deeper on any specific part?

For example:
- **The RAG pipeline internals** (chunking strategy + embedding retrieval → reranking flow)
- **The Paperless webhook integration** and why hybrid approach with poller fallback is better than pure event-driven
- **Backup verification logic** (`restic check` vs actual restore test in `task backup:verify`)
- **Auth flow**: how JWT cookies work, httpOnly + SameSite=Lax reasoning
