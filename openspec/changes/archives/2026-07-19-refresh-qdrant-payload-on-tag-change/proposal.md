## Why

The RAG indexer (auto-tagger) writes a document's chunk-level Qdrant payload — `doc_type`, `correspondent`, `tags`, `created_date` — exactly once, at the moment the document first reaches `ai-propagated`. Any native-tag change made after that point (most commonly: a user edits "Vorgeschlagene Tags" on an already-filed Library document, or any other process changes the doc's native Paperless tags post-propagation) never reaches Qdrant. Because `aktenraum_api.ai.retrieval` builds its dense-search payload filter directly from this stale metadata, "Ask AI" queries that filter by tag silently miss documents whose tags changed after indexing — with no error, warning, or user-visible signal that the index is out of date.

## What Changes

- Add a lightweight, metadata-only Qdrant payload refresh path in the auto-tagger: given a doc id, re-resolve `doc_type` / `correspondent` / `tags` / `created_date` from Paperless and update the existing Qdrant points' payload **without re-chunking or re-embedding** (the underlying text hasn't changed, so vectors stay valid).
- Trigger that refresh whenever native tags change on a document that is already `ai-propagated` and already indexed. In-scope trigger: the existing "save AI fields" path (`PATCH /api/documents/{id}/fields`) when it's called against an already-propagated document and the `ai_suggested_tags` field is part of the diff. (Native-tag edits made directly in Paperless's own UI, outside aktenraum's control plane, remain out of scope — see Impact.)
- No changes to the indexer's chunking/embedding code path, no changes to the retrieval/rerank pipeline, no new lifecycle tags or state-machine transitions.

## Capabilities

### New Capabilities
- `rag-index-freshness`: keeps the Qdrant chunk-payload metadata (tags, correspondent, document_type) in sync with Paperless's native fields after a document has already been indexed, via a metadata-only refresh that avoids unnecessary re-embedding.

### Modified Capabilities
(none — no existing capability spec covers RAG indexing behavior yet, so this ships as a new capability rather than a delta)

## Impact

- **Affected code**: `services/auto-tagger/src/auto_tagger/indexer.py` (new metadata-only update function, reusing `_resolve_payload_metadata`), `packages/aktenraum-core/src/aktenraum_core/rag/` vector store client (needs a payload-only update method alongside the existing delete+upsert), `services/aktenraum-api/src/aktenraum_api/documents/service.py` (or wherever `PATCH /api/documents/{id}/fields` lives) to fire the trigger, and `services/auto-tagger/src/auto_tagger/webhook.py`/`main.py` if a new internal trigger endpoint is needed (mirroring the existing `/trigger/propagate` pattern).
- **Out of scope**: tag changes made directly through Paperless's own admin UI (bypassing aktenraum-api) are not observed by aktenraum today for any purpose, and this change does not add that observability — it only closes the gap for edits made through aktenraum's own review pages.
- **No breaking changes**: purely additive; existing indexing-at-first-propagation behavior is unchanged.
