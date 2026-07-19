## ADDED Requirements

### Requirement: Metadata-only Qdrant payload refresh
The system SHALL provide a way to update the `doc_type`, `correspondent`, `tags`, and `created_date` payload fields of every Qdrant point belonging to a given document id, without re-chunking the document's text or recomputing embeddings.

#### Scenario: Refreshing an already-indexed document
- **WHEN** a document with existing Qdrant chunk points has its metadata refreshed via `update_metadata_by_doc_id`
- **THEN** every point for that `doc_id` has its `tags`, `correspondent`, `doc_type`, and `created_date` payload fields updated to the newly-resolved values, and its `text`, `chunk_index`, `char_start`, `char_end`, `token_count`, and vector are left unchanged

#### Scenario: Refreshing a document that was never indexed
- **WHEN** a metadata refresh is requested for a `doc_id` that has zero points in Qdrant
- **THEN** the operation completes without error and has no effect

### Requirement: Star/unstar triggers a metadata refresh
Whenever a document's native Paperless tags change via the star or unstar action, the system SHALL attempt to refresh that document's Qdrant payload metadata so retrieval-time tag filtering reflects the new tag state.

#### Scenario: Starring an already-indexed document
- **WHEN** a user stars a document that has already been indexed (is `ai-propagated` with existing Qdrant points)
- **THEN** the system adds `wichtig` to the native tags in Paperless AND best-effort triggers a Qdrant metadata refresh for that document, so a subsequent Ask-AI query filtered by the `wichtig` tag can retrieve it

#### Scenario: Unstarring an already-indexed document
- **WHEN** a user unstars a document that has already been indexed
- **THEN** the system removes `wichtig` from the native tags in Paperless AND best-effort triggers a Qdrant metadata refresh for that document, so a subsequent Ask-AI query filtered by the `wichtig` tag no longer retrieves it

#### Scenario: Refresh trigger fails or times out
- **WHEN** the best-effort call to refresh Qdrant metadata fails, times out, or the auto-tagger is unreachable
- **THEN** the star/unstar request still succeeds and returns normally to the caller; the failure is logged but never surfaces as an error to the user

### Requirement: Internal trigger endpoint for metadata refresh
The auto-tagger SHALL expose an internal, secret-gated HTTP endpoint that accepts a document id and performs the metadata-only Qdrant refresh for that document, following the same authentication and best-effort conventions as the existing `/trigger/extract` and `/trigger/propagate` endpoints.

#### Scenario: Valid request with matching secret
- **WHEN** `POST /trigger/reindex-metadata` is called with a valid `document_id` and (if `WEBHOOK_SECRET` is set) a matching `X-Aktenraum-Secret` header
- **THEN** the auto-tagger resolves the document's current native tags/correspondent/document_type/created_date and refreshes the corresponding Qdrant payload

#### Scenario: Invalid or missing secret
- **WHEN** `WEBHOOK_SECRET` is set and the request is missing the header or the header doesn't match
- **THEN** the endpoint rejects the request without performing any refresh
