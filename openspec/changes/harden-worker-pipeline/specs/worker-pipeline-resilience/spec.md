## ADDED Requirements

### Requirement: AI-field writes preserve unrelated custom fields
Writing extraction results to Paperless SHALL replace only the AI custom fields the worker manages and SHALL keep every other custom field on the document unchanged.

#### Scenario: user-defined field survives re-extraction
- **WHEN** a document carries a user-defined custom field and is re-extracted
- **THEN** the PATCH payload contains that field with its original value alongside the new AI values

#### Scenario: stale AI value is cleared
- **WHEN** the new extraction has no value for a managed AI field that the document previously had
- **THEN** that AI field is absent from the PATCH payload

### Requirement: Propagation only runs on approved documents
The worker SHALL propagate a document only if the document fetched at dequeue time carries `ai-approved`.

#### Scenario: duplicate propagation trigger
- **WHEN** a document that has already been propagated is dequeued again
- **THEN** no Paperless write happens and `skip_not_approved` is logged

#### Scenario: trigger for a pending document
- **WHEN** `/trigger/propagate` is called for a document tagged `ai-pending`
- **THEN** the document is not propagated

### Requirement: Indexing never loses existing chunks on embedder failure
The indexer SHALL compute embeddings before deleting a document's existing chunks.

#### Scenario: embedder down during re-index
- **WHEN** embedding fails for an already-indexed document
- **THEN** its existing Qdrant chunks are not deleted and the document is tagged `ai-index-error`

### Requirement: Metadata-only reindex
A `reindex-metadata` trigger SHALL update the Qdrant payload without re-embedding when the document already has chunks, and SHALL fall back to a full index when it has none.

#### Scenario: star an indexed document
- **WHEN** `reindex-metadata` is triggered for a document with indexed chunks
- **THEN** the payload is updated and the embedder is not called

### Requirement: Startup index reconcile
On startup with RAG enabled the worker SHALL enqueue every `ai-propagated` document that has zero indexed chunks.

#### Scenario: restart with a pending indexing backlog
- **WHEN** the worker restarts after propagating documents it had not yet indexed
- **THEN** those documents are indexed without a manual backfill

### Requirement: Bounded LLM calls
Structured Ollama calls SHALL time out after `LLM_TIMEOUT_SECONDS` and SHALL request an explicit `num_ctx` of `OLLAMA_NUM_CTX`.

#### Scenario: hung model
- **WHEN** the model does not answer within the timeout
- **THEN** the call fails and the extraction consumer moves on to the next document

### Requirement: Transient LLM failures are retried
A transient LLM failure SHALL leave the document without a lifecycle tag so the poller retries it, up to 3 transient failures per document, after which it SHALL be tagged `ai-error`.

#### Scenario: Ollama briefly offline
- **WHEN** extraction fails with a connection error for the first time
- **THEN** no lifecycle tag is written and `extraction_deferred` is logged

#### Scenario: persistent outage
- **WHEN** the same document fails transiently for the third time
- **THEN** it is tagged `ai-error` with the error message recorded

### Requirement: Lifecycle tags merge onto current tags
Routing tags SHALL be merged onto the document's tags as read immediately before the write.

#### Scenario: user stars a document during extraction
- **WHEN** a tag is added to the document while the LLM call is running
- **THEN** that tag is still present after the lifecycle tags are applied

### Requirement: Extraction model follows the active setting
The worker SHALL use the model returned by `GET /api/settings/active-llm-model` for Ollama extraction, cached for 60 seconds, falling back to `OLLAMA_MODEL` when the API is unreachable and no cached value exists.

#### Scenario: operator switches model in settings
- **WHEN** the active model is changed in the SPA
- **THEN** extractions started after the cache expires use the new model

### Requirement: Invalid auto-approve thresholds fail closed
An auto-approve rule whose `min_confidence` is not a finite number SHALL be treated as disabled.

#### Scenario: null threshold
- **WHEN** the rule store returns `min_confidence: null` for an enabled type
- **THEN** documents of that type route to `ai-pending`
