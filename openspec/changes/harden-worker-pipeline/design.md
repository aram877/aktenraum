## Context

The worker runs serial queue consumers (extraction, propagation, indexing) fed by the 30 s pollers and the `/trigger/*` webhook. Paperless's `custom_fields` and `tags` PATCHes are full-array replace. Queues are in-memory.

## Decisions

**Custom-field merge.** `patchDocumentAiFields` reads the document, drops existing entries whose field id is one of the AI fields it manages, appends the new non-null values and PATCHes the merged array. Managed-but-null fields are therefore cleared (re-extraction must not leave stale AI values), unmanaged fields are kept verbatim. Same idiom as `setErrorMessage` and the API's `mergeCustomFields`.

**Propagation guard lives in `processApprovedDocument`.** Both the poller and the webhook feed the same consumer, so the check sits at the top of the handler on the document it was given (fetched on dequeue). Duplicate enqueues become no-ops after the first run removes `ai-approved`.

**Embed-then-replace.** Embeddings are computed before `deleteByDocId`. A failure before the delete leaves the old chunks searchable; the delete + upsert window remains but no longer depends on Ollama.

**Metadata refresh.** A separate `reindexMetadata(docId)` uses `countChunksForDoc`; > 0 → `updateMetadataByDocId`, otherwise full `indexDocument`. The webhook's `reindex-metadata` trigger feeds a dedicated queue drained by the indexer consumer with a discriminated item type, keeping one serial writer to Qdrant.

**Startup reconcile instead of a persistent queue.** Paging all `ai-propagated` docs and calling `countChunksForDoc` is what `backfill` already does and costs one cheap Qdrant count per doc. Running it once at boot covers lost queue items without adding storage. Documents with no OCR text produce zero chunks and are re-checked each boot; acceptable.

**Transient vs permanent LLM errors.** Transient = `AbortError`/`TimeoutError`, `TypeError: fetch failed`, Node connection error codes, or an error carrying HTTP status 429 or ≥ 500. An in-memory `Map<docId, count>` bounds retries to 3; the poller is the retry mechanism (no extra timer). Counter resets on success and on restart (a restart is itself a reasonable retry boundary).

**Timeouts only on structured calls.** `OllamaBackend` gets a second client whose `fetch` adds `AbortSignal.timeout`. Streaming (`streamText`, used by the API's Ask) keeps the unbounded client so long answers are not cut.

**Active model.** `ActiveModelConfig` mirrors `AutoApproveConfig` (60 s TTL, in-flight de-dup, reuse warm cache on failure, fall back to `OLLAMA_MODEL` cold). The extraction handler builds an `OllamaBackend` per document from the resolved model; construction is cheap. Anthropic ignores it.

## Risks

- `OLLAMA_NUM_CTX=24576` raises KV-cache memory for the extraction model (≈5 GB for a 14B); sized for MAX_TOKENS_INPUT=8000 + ~6k prompt tokens + 4096 output. Configurable; set lower on small hosts.
- Startup reconcile issues one Qdrant count per propagated doc; fine for a personal corpus (hundreds to low thousands).
