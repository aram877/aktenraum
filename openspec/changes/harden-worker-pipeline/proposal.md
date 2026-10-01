## Why

A full-app review on 2026-10-01 found that the worker pipeline (auto-tagger + the Paperless client in `@aktenraum/core`) can silently lose user data, propagate documents that were never approved, wipe a document out of RAG search, and stall or strand every document when the LLM blips. None of the end-to-end flows (`processDocument`, `processApprovedDocument`, `indexDocument`) are covered by tests, which is how these shipped.

## What Changes

- AI-field writes merge into the document's existing `custom_fields` instead of replacing the whole array, so user-defined custom fields survive extraction and reprocess.
- Propagation re-checks that the freshly fetched document still carries `ai-approved`; anything else is skipped (`skip_not_approved`).
- Indexing embeds before it deletes, so an embedder outage never removes a document's existing chunks.
- `/trigger/reindex-metadata` refreshes only the Qdrant payload when chunks exist (no re-embed), falling back to a full index when none do.
- On startup the worker reconciles the RAG index: every `ai-propagated` document with zero chunks is enqueued for indexing (the in-memory queue does not survive restarts).
- With `QDRANT_URL` unset nothing is pushed onto the indexing queue.
- Ollama structured calls get a request timeout (`LLM_TIMEOUT_SECONDS`, default 300) and an explicit context window (`OLLAMA_NUM_CTX`, default 24576).
- Transient LLM failures (connection refused, timeout, HTTP 429/5xx) leave the document untouched so the poller retries it; after 3 transient failures for the same document it is tagged `ai-error`.
- Lifecycle tags are applied on top of a fresh read of the document's tags, so user tag edits made during the LLM call are kept.
- The worker resolves the extraction model from `GET /api/settings/active-llm-model` (60 s cache, `OLLAMA_MODEL` fallback), restoring the Python worker's behaviour.
- The Anthropic structured path sends the system prompt as the top-level `system` param and allows 4096 output tokens.
- Auto-approve rules with a non-finite `min_confidence` are treated as disabled (fail closed).
- Entity name maps paginate past 200 entries.
- Webhook request bodies are capped at 64 KiB.

Out of scope (separate changes): duplicate detection still compares the retired `ai_monetary_amount`; the API-side 200-entry cap in `PaperlessGateway.listNamed`; empty `WEBHOOK_SECRET` disabling the gate.

## Capabilities

### New Capabilities
- `worker-pipeline-resilience`: data-preservation, state-guard, indexing-safety and LLM-failure guarantees of the extraction → propagation → indexing pipeline.

### Modified Capabilities

## Impact

- `packages/aktenraum-core/src/paperless/client.ts`, `src/llm/{ollamaBackend,anthropicBackend,factory}.ts`
- `services/auto-tagger/src/{main,extract,propagate,indexer,webhook,config,auto-approve-config}.ts`, new `active-model.ts`, `transient.ts`
- New env vars `LLM_TIMEOUT_SECONDS`, `OLLAMA_NUM_CTX` (both optional) in `docker/.env.example`
- No schema or API contract changes.
