# Design

## Context

`RetrievalModule` (`services/aktenraum-api/src/ai/retrieval.module.ts`) returns `null` when there's no vector store. Otherwise it builds `{embedder, vectorStore, reranker}` and fires a background prewarm of `LocalReranker`. The vector store (`VECTOR_STORE`, `rag/rag.module.ts`) is used by more than retrieval: `TrashFlagsService`, the share mirror, moves and member removal all write payloads through it. The e2e compose sets `QDRANT_URL: ""` only to avoid the prewarm. As a side effect it also turns off all of these writes.

`retrieveChunksForQuestion` (`ai/retrieval.ts`) already falls back to dense order when `rerank` throws (`rag_retrieve_rerank_failed`).

## Goals / Non-Goals

Goals: the e2e api writes to the e2e Qdrant exactly like production, and stays within 1 GB. Rehearsals can then assert those writes.

Non-goals: see the proposal.

## Decisions

### D1. `RERANKER_ENABLED` (bool, default true) instead of a prewarm-only switch

The backlog sketched `RERANK_PREWARM=false`. Skipping only the prewarm isn't enough: the removal rehearsal runs Ask, and the first rerank would load the model lazily and OOM-kill the container mid-stream (the exit 137 gotcha). With `RERANKER_ENABLED=false`, no reranker object is constructed at all, so the model can't load.

### D2. `RetrievalDeps.reranker: Reranker | null`; null means dense order

When the reranker is `null`, `retrieveChunksForQuestion` takes the top `rerankTopK` hits in Qdrant's order with Qdrant's scores. This is the same order the existing failure fallback produces, but without the warning. It's an explicit branch, not an exception: logging `rag_retrieve_rerank_failed` on every request would be noise. The fallback is shared as one helper (`denseOrder`) so the two paths can't drift.

### D3. Startup log, no per-request log

`RetrievalModule` logs `reranker_disabled` once when the setting is false. `rag_retrieve_complete` gains a `reranker_used: boolean` field (`reranked` is already the result count) so an eval run shows which ordering it measured.

### D4. Rehearsal assertions read Qdrant directly

Rehearsals already scroll `aktenraum_chunks` on port 6433 with the e2e key. The new checks use the same helper. They poll briefly (≤ 10 s), because share and move writes are synchronous in the request but trash flags are best effort.

## Risks / Trade-offs

- Someone sets `RERANKER_ENABLED=false` in production by mistake → retrieval quality drops silently apart from the startup line. Mitigation: the variable is documented as a test/low-memory switch, it's absent from `.env.example`, and the eval output shows `reranker_used`.
- The e2e api now reaches Qdrant, so a broken e2e Qdrant fails more rehearsal checks. That's intended.

## Migration Plan

None for live installs: the default keeps today's behaviour. The e2e stack picks the change up on the next `bash scripts/e2e-worker.sh` (the api is rebuilt from the tree).
