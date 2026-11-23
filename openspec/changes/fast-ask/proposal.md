# Proposal

## Why

Ask AI is slow and feels unpredictable. Each question runs two different chat models one after the other: a filter LLM (`gemma4:26b`, 18.7 GB) and then an answer LLM (`qwen2.5:14b-instruct-q8_0`, 19.9 GB VRAM at `num_ctx` 24576). They can't both fit on the 24 GB GPU, so Ollama swaps them on every question. Measured on 2026-11-23, the cold loads took **56 s** and **40 s**. In between come up to 15 sequential Paperless `getDocument` calls and a CPU rerank of 50 candidates. Nothing streams until all of that is done. The filter LLM also guesses document types and correspondents, and a wrong guess makes answers look arbitrary. The goal is the fastest Ask possible: sources in under ~1 s, first answer token in ~1–2 s once the model is warm.

## What Changes

- **BREAKING (internal)**: `/api/ai/answer/stream` no longer calls an LLM to extract a search filter. Retrieval comes first:
  - Qdrant dense search (plus rerank) and a Paperless full-text search run **in parallel**.
  - A deterministic, LLM-free parser adds structured narrowing (years and date ranges, document types from the existing German intent keywords, correspondents by name match against the known list).
- New SSE event order: `sources` (the documents that will be in the prompt, sent as soon as retrieval finishes) → `chunk`… → `final`. The `meta` event's `filter` and `explanation` now describe the parsed filter (no LLM involved).
- The answer candidates are loaded with **one** batched Paperless call (`id__in`) and **one** batched type-fields query instead of N sequential calls.
- Reranking is configurable and smaller: `RERANK_CANDIDATES` (default 20 instead of 50); `RERANKER_ENABLED=false` still skips it.
- Ollama requests carry `keep_alive` (`OLLAMA_KEEP_ALIVE`, default `-1` for the answer model), so the model stays resident. The answer call gets its own context size (`OLLAMA_ANSWER_NUM_CTX`) and a tighter prompt budget.
- The `/settings` LLM section warns when the extraction and answer models differ: two different models can't stay resident on one GPU.
- The Ask page renders source cards as soon as `sources` arrives and streams the answer below them. It shows a per-phase status ("Suche…", "Antwort wird geschrieben…") instead of one silent spinner.
- **BREAKING (internal)**: the non-streaming `POST /api/ai/answer` is removed. No frontend or script calls it, only its own tests do. `/api/ai/find` (backend-only, structured LLM filter) stays unchanged.
- Timing instrumentation: one `ask_timing` log event per question with per-stage milliseconds (parse, retrieve, enrich, first token, total).

## Capabilities

### New Capabilities
- `ask-answer`: how the Ask feature turns a question into a cited, streamed German answer. Covers retrieval-first candidate selection, the deterministic question parser, the SSE event contract, latency-related model handling and tenancy scoping of every retrieval path.

### Modified Capabilities
<!-- none — main specs are not kept in this repo (openspec/specs/ does not exist) -->

## Impact

- **api**: `src/ai/ai.controller.ts` (new stream pipeline, `/answer` removed), `src/ai/ai.service.ts` (batched enrichment, parallel retrieval), new `src/ai/question-parser.ts`, `src/ai/retrieval.ts` (candidate count), `src/ai/answer-prompt.ts` (prompt budget), `src/ai/llm-backend.provider.ts` (answer `num_ctx` / `keep_alive`), `src/ai/ai.schemas.ts`, tests `test/ask.routes.test.ts`, `ai.service.test.ts`, `retrieval.test.ts`.
- **core**: `llm/ollamaBackend.ts` + `llm/factory.ts` (`keepAlive` option, per-backend `numCtx`).
- **web**: `utils/sse.ts` (`sources` event), `composables/useAnswerStream.ts`, `pages/ask.vue`, settings LLM section (mismatch hint), tests `tests/nuxt/ask.spec.ts`.
- **config**: new optional `RERANK_CANDIDATES`, `OLLAMA_KEEP_ALIVE`, `OLLAMA_ANSWER_NUM_CTX` in `docker/.env.example` + `docs/configuration.md`.
- **docs**: CLAUDE.md (Ask section, the API's AI notes), `docs/architecture.md` RAG section, `docs/api-reference.md` (`/answer` removed, SSE events).
- **No data migration, no re-index.** The Qdrant payload is unchanged. Rehearsal scripts that read the stream (`share-rehearsal.mjs`, `removal-rehearsal.mjs`) keep working: they read `final`, which keeps its shape.
