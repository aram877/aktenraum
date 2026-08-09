## ADDED Requirements

### Requirement: Paperless client parity
The TypeScript Paperless client SHALL replicate every documented gotcha-handling behavior of the Python `PaperlessClient`/`PaperlessGateway`: exact-name lookups via `?name__iexact=` (never bare `?name=`), full-array replace semantics for `custom_fields` and `tags` PATCH (read-merge-write by field id, never a partial payload), and a client-side equality re-check after any name-based lookup as defence in depth.

#### Scenario: Tag lookup by name uses iexact filter
- **WHEN** the client looks up a tag by name (e.g. `ai-pending`)
- **THEN** it issues the request with `?name__iexact=<name>` and verifies the returned tag's name matches case-insensitively before using its id

#### Scenario: Custom field PATCH preserves unrelated fields
- **WHEN** the client updates one `ai_*` custom field on a document that has 11 other custom fields already set
- **THEN** it first reads the document's current `custom_fields` array, merges the new value into the entry matching the target field id, and PATCHes the full merged array — the other 11 fields remain unchanged after the call

### Requirement: Field normalisation at the Paperless boundary
The shared library SHALL normalise LLM-produced values into the formats Paperless's API accepts before any PATCH: monetary values to `<ISO_CODE><amount>` (e.g. `EUR149.99`), dates to strict `YYYY-MM-DD`, and `string`-type custom-field values truncated to 128 characters with an ellipsis, while `longtext`-type fields (per an explicit allowlist) are passed through untruncated.

#### Scenario: German monetary format is normalised
- **WHEN** the LLM emits `"149,99 EUR"` for a monetary field
- **THEN** the normaliser produces `"EUR149.99"` before the PATCH is sent

#### Scenario: Longtext field skips truncation
- **WHEN** a value longer than 128 characters is written to a field present in the longtext allowlist (e.g. an AI summary field)
- **THEN** the value is sent unmodified, without the 128-char truncation applied to `string`-type fields

### Requirement: LLM output coercion
The shared library's schema layer (zod-based) SHALL coerce common small-LLM output defects the same way the existing Pydantic `BeforeValidator`s do: `null` for a list field becomes `[]`, and non-string list items (e.g. an integer in a list of strings) are coerced to strings, before schema validation runs.

#### Scenario: Null list field is coerced to empty array
- **WHEN** the LLM response contains `"suggested_tags": null`
- **THEN** validation succeeds and the parsed value is `[]`, not a validation error

#### Scenario: Mixed-type list is coerced to strings
- **WHEN** the LLM response contains `"reference_numbers": [42, "RE-2024-01"]`
- **THEN** the parsed value is `["42", "RE-2024-01"]`

### Requirement: LLM backend abstraction
The shared library SHALL provide a common interface for both an Ollama backend and an Anthropic backend, selectable via configuration, so callers (worker and API) do not branch on backend type.

#### Scenario: Backend selection via configuration
- **WHEN** the configured backend is `ollama`
- **THEN** LLM calls are routed to the configured Ollama base URL using the resolved model name
- **WHEN** the configured backend is `anthropic`
- **THEN** LLM calls are routed to the Anthropic API using `ANTHROPIC_API_KEY`

### Requirement: RAG chunking and vector store parity
The shared library SHALL reproduce the existing chunking algorithm (paragraph-aware with sentence-level fallback, ~500 token target, ~50 token overlap, 200-chunk cap per document) and the existing Qdrant write pattern (delete-by-doc-id then upsert, so re-indexing a document never leaves duplicate chunks).

#### Scenario: Re-indexing does not duplicate chunks
- **WHEN** a document that was previously indexed is indexed again (e.g. after a content correction)
- **THEN** the vector store first deletes all existing points for that document id, then upserts the new chunk set, so a subsequent query returns exactly the new chunk count for that document

### Requirement: In-process reranker
The shared library SHALL provide a cross-encoder reranking function backed by an ONNX export of `bge-reranker-v2-m3`, running in-process via `onnxruntime-node`/transformers.js, with no external Python process involved.

#### Scenario: Rerank scores a candidate set
- **WHEN** given a query string and a list of up to 50 candidate text chunks
- **THEN** the reranker returns a relevance score per candidate, usable to sort candidates before truncating to the top 5, without making any network call to a Python service
