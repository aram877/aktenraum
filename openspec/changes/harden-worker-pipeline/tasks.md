## 1. Core library

- [x] 1.1 `patchDocumentAiFields` merges into existing `custom_fields` (keep unmanaged, replace managed)
- [x] 1.2 `getEntityNameMap` paginates
- [x] 1.3 `OllamaBackend`: timeout client for `complete`, `num_ctx` option; factory passes both
- [x] 1.4 `AnthropicBackend.complete` uses `splitSystem`, 4096 max tokens
- [x] 1.5 Tests for 1.1–1.4

## 2. Worker

- [x] 2.1 `processApprovedDocument` skips documents without `ai-approved`
- [x] 2.2 `indexDocument` embeds before delete; add `reindexMetadata`
- [x] 2.3 Indexer queue carries `{kind, docId}`; webhook `reindex-metadata` uses the metadata path
- [x] 2.4 Startup reconcile enqueues propagated docs with zero chunks
- [x] 2.5 No indexing-queue pushes when `QDRANT_URL` is unset
- [x] 2.6 Transient LLM error classification + 3-strike counter in `processDocument`
- [x] 2.7 `applyTags` re-reads tags before writing
- [x] 2.8 `ActiveModelConfig` + per-document backend for Ollama
- [x] 2.9 `parseRuleSet` treats non-finite `min_confidence` as disabled
- [x] 2.10 Webhook body cap
- [x] 2.11 Config: `LLM_TIMEOUT_SECONDS`, `OLLAMA_NUM_CTX`; `.env.example`
- [x] 2.12 Flow tests for `processDocument`, `processApprovedDocument`, `indexDocument`, `reindexMetadata`, `ActiveModelConfig`, `parseRuleSet`

## 3. Verify and document

- [x] 3.1 `pnpm -r lint`, `pnpm -r build`, `pnpm -r test`
- [x] 3.2 Rebuild auto-tagger, check startup logs, run `scripts/e2e-worker.sh` (20/20)
- [x] 3.3 CLAUDE.md + docs/configuration.md updates
- [x] 3.4 Session note at commit time
