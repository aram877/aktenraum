# ADR-004: Keep auto-tagger and aktenraum-api as separate Python services

**Status**: Accepted

## Context

aktenraum's Python code is split across two services that share `aktenraum-core`:

- **auto-tagger** — five long-running async tasks in one process: extraction worker, extraction poller, propagation worker, propagation poller, indexer worker. Holds a bounded asyncio.Queue per pipeline stage, exposes an internal HTTP listener for trigger webhooks (`/trigger/extract`, `/trigger/propagate`, `/processing`, `/health`).
- **aktenraum-api** — FastAPI HTTP server serving the SPA: auth, inbox review, library, upload, RAG-backed Ask AI, document-detail proxies. Owns the `aktenraum` Postgres database. Lifespan pre-warms the bge-reranker-v2-m3 cross-encoder (~2.1 GB in RSS).

A recent code review flagged the split as a candidate for collapse: both services talk to Paperless, both call LLMs, both depend on `aktenraum-core`, and the env files have to keep `PAPERLESS_API_TOKEN` / `WEBHOOK_SECRET` / `LLM_BACKEND` in sync. The question was whether the split was deliberate or had merely accreted, and whether one Python process with FastAPI lifespan-spawned background tasks would be simpler at this scale.

This ADR records the deliberate decision so future contributors don't re-litigate it without new evidence.

## Decision

We will keep auto-tagger and aktenraum-api as separate services.

The driving reason is **process isolation**. auto-tagger runs five concurrent asyncio tasks that perform multi-second blocking work: LLM round-trips against Ollama or Anthropic, paragraph-aware chunking, Qdrant upserts, propagation PATCHes against Paperless. aktenraum-api serves HTTP requests including the SSE-streamed `/api/ai/answer/stream` and lifespan-warms the bge-reranker (~2.1 GB RSS, cross-encoder rerank ~50 ms × 50 candidates per request). Cohabiting these on a single asyncio event loop would mean:

- A slow extraction call back-pressures the FastAPI request loop, manifesting to the user as a hung SPA even though the actual hang is upstream of the request handler.
- Memory caps in Docker (`mem_limit:`) collapse to the worst-case of both workloads combined — there is no per-stage budget the operator can tune.
- A restart triggered by either workload (prompt-text edit, SPA deploy, Alembic migration) takes down the other. The current cadence — auto-tagger restarts on prompt or model changes, aktenraum-api restarts on SPA / endpoint changes — means session-bound HTTP work and in-flight extractions are insulated from each other.
- The bge-reranker's `sentence-transformers` blocking model load would happen inside the same asyncio worker as Paperless PATCHes; the existing `asyncio.Lock` would still serialise on the reranker, but the lock would block the event-loop slot rather than just one background task.

Secondary reasons:

- The webhook + worker pattern is already there for extraction; the propagation webhook added in `code-review-cleanups` reuses it. Splitting webhook delivery from request handling reduces the attack surface (port 8001 is never exposed outside the Compose network; port 8002 / nginx is the only public-ish surface).
- Operator restarts (`task tagger:rebuild` vs `task api:rebuild`) match the natural change axes: prompt / extraction logic vs HTTP surface / SPA-facing schemas.

## Consequences

**Easier:**

- Per-service memory limits and CPU shares in Docker.
- Independent restart cadences; deploying an SPA fix doesn't risk dropping an in-flight LLM call.
- Smaller blast radius on a bug — an OOM in the reranker doesn't take down the extraction queue.
- Health surfaces stay narrow per service: `/api/health` for the SPA path, `/processing` + `/health` on auto-tagger:8001 for the worker side.

**Harder:**

- Three secrets (`PAPERLESS_API_TOKEN`, `WEBHOOK_SECRET`, `LLM_BACKEND`) must agree across `docker/auto-tagger.env` and `docker/aktenraum-api.env`. `bootstrap-secrets.sh` reconciles them; documented in `CLAUDE.md` under "Credentials & secrets".
- Approve and reprocess pay one in-cluster HTTP round-trip on top of the Paperless PATCH because they live on the API side and need to wake the worker side. Both are best-effort and bounded (`/trigger/propagate` 2 s, `/trigger/extract` 10 s) — failures never fail the parent request, the poller catches the miss.
- Two health endpoints to keep current and two CI matrices (`task test:py` runs the union; CI parallelises).
- New Python code that needs both worker and HTTP concerns has to pick a side. Default: HTTP-shaped or SPA-facing → aktenraum-api; queue-driven, lifecycle-tag-modifying, or LLM-extracting → auto-tagger.

## Revisit when

Reopen the question if **any** of these become true:

1. **A third Python service appears.** Two services is the natural pair (worker + API). Three starts to look like a microservices habit and warrants either a service-mesh story or a collapse.
2. **RSS pressure on a single host forces collapse.** If running both processes plus Ollama + Qdrant on the smallest supported machine OOMs, fusing them into one Python process avoids the ~150 MB Python-runtime duplication. Today the duplication is a comfortable fraction of total RAM.
3. **The reranker and the extraction loop want to share a model handle.** Today they don't — extraction runs the chat-style LLM (Ollama qwen2.5, or Anthropic), retrieval runs bge-m3 + bge-reranker. If we move reranker calls into the extraction prompt pipeline, sharing the loaded weights via one process becomes attractive.
4. **Webhook latency starts being load-bearing in user-perceived UX.** Today the trigger calls are best-effort with the poller as safety net. If the SPA grows to depend on synchronous worker callbacks, the network hop is a real cost.

This ADR does NOT block collapsing later — it only records the rationale for the current state so the next person to ask the question gets a real answer instead of guessing.
