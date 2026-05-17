## ADDED Requirements

### Requirement: aktenraum-api lists trashed documents via GET /api/trash/

The service SHALL expose `GET /api/trash/` returning a paginated list of documents that are currently in Paperless's trash (i.e. present in `/api/trash/` upstream). The endpoint SHALL be auth-gated, accept `page` (≥1, default 1), `page_size` (1..100, default 20), and `ordering` (allowlisted; default sorts oldest-deleted-first so the closest-to-auto-purge rows are at the top). Each item SHALL carry at minimum: `id`, `title`, `created_date`, `deleted_at`, native `correspondent_id`, native `document_type_id`, and the auto-tagger's stored `ai_correspondent` / `ai_document_type` / `ai_summary_de` fallbacks for rows whose native lookups are unset.

#### Scenario: List returns trashed documents oldest-first
- **WHEN** `GET /api/trash/` is called on a user who has three docs in the Paperless trash with `deleted_at` 2026-05-10, 2026-05-12, 2026-05-15
- **THEN** the response is HTTP 200 with `results` ordered `[2026-05-10, 2026-05-12, 2026-05-15]` and `total` 3

#### Scenario: List paginates
- **WHEN** the user has 25 docs in trash and requests `?page=2&page_size=10`
- **THEN** the response contains `results` of length 10, `page=2`, `page_size=10`, `total=25`

#### Scenario: List requires auth
- **WHEN** `GET /api/trash/` is called without a valid session cookie
- **THEN** the response is HTTP 401

### Requirement: aktenraum-api restores a trashed document via POST /api/trash/{id}/restore

The service SHALL expose `POST /api/trash/{id}/restore`. The handler SHALL translate to Paperless's `POST /api/trash/ {"documents": [id], "action": "restore"}` and return HTTP 204 on success, 404 when the id is not in the trash, 401 when the session is unauthenticated, and 502 when Paperless rejects the API token. Restore SHALL NOT touch Qdrant — soft-delete never removed the chunks, so restore is a no-op there.

#### Scenario: Restore moves the doc out of trash
- **WHEN** `POST /api/trash/42/restore` is called for a doc currently in trash
- **THEN** the response is HTTP 204 and the doc is visible in `GET /api/documents/` again

#### Scenario: Restore of an id not in trash returns 404
- **WHEN** `POST /api/trash/9999/restore` is called for an id that is not in `/api/trash/`
- **THEN** the response is HTTP 404 with a JSON body explaining the id is not in the trash

### Requirement: aktenraum-api hard-deletes one trashed document via POST /api/trash/{id}/delete

The service SHALL expose `POST /api/trash/{id}/delete`. The handler SHALL invoke Paperless's `POST /api/trash/ {"documents": [id], "action": "empty"}` to hard-delete the doc, then SHALL call `vector_store.delete_by_doc_id(id)` to purge the doc's chunks from Qdrant when `app.state.rag_vector_store` is set. The Paperless hard-delete result is authoritative; Qdrant cleanup is best-effort. The endpoint SHALL return HTTP 204 on Paperless success regardless of whether Qdrant cleanup succeeded.

#### Scenario: Hard-delete removes from Paperless and Qdrant
- **WHEN** `POST /api/trash/42/delete` is called and the doc is in Paperless trash
- **THEN** Paperless `POST /api/trash/` receives `{"documents": [42], "action": "empty"}`, and the vector store receives `delete_by_doc_id(42)`, and the response is HTTP 204

#### Scenario: Hard-delete succeeds even when Qdrant is unreachable
- **WHEN** `POST /api/trash/42/delete` is called and the vector store raises a connection error after Paperless returns 2xx
- **THEN** the response is still HTTP 204 and the failure is logged at warning level with the doc id

#### Scenario: Hard-delete works when QDRANT_URL is empty
- **WHEN** `POST /api/trash/42/delete` is called and `app.state.rag_vector_store` is `None`
- **THEN** the response is HTTP 204 and no vector-store calls are attempted

#### Scenario: Hard-delete of an id not in trash returns 404
- **WHEN** `POST /api/trash/9999/delete` is called for an id that is not in `/api/trash/`
- **THEN** the response is HTTP 404

### Requirement: aktenraum-api empties the entire trash via POST /api/trash/empty

The service SHALL expose `POST /api/trash/empty` (empty body). The handler SHALL enumerate every id currently in `/api/trash/` BEFORE the empty call (so the SPA can show how many were hard-deleted), invoke Paperless's `POST /api/trash/ {"documents": [...all ids...], "action": "empty"}`, and then call `vector_store.delete_by_doc_id(id)` for each id when `app.state.rag_vector_store` is set. The response SHALL include `{"emptied": <count>}` so the SPA can render an accurate confirmation toast.

#### Scenario: Empty hard-deletes every trashed doc and reports the count
- **WHEN** the user has 7 docs in the trash and calls `POST /api/trash/empty`
- **THEN** the response is HTTP 200 with body `{"emptied": 7}`, Paperless `/api/trash/` is empty, and the vector store received seven `delete_by_doc_id` calls

#### Scenario: Empty on an empty trash is a no-op
- **WHEN** `POST /api/trash/empty` is called with zero docs in the trash
- **THEN** the response is HTTP 200 with body `{"emptied": 0}` and no Paperless or Qdrant mutation is attempted

### Requirement: aktenraum-api soft-deletes (NOT hard-deletes) via DELETE /api/documents/{id}/

The existing `DELETE /api/documents/{id}/` endpoint SHALL behave as a soft-delete: the document is moved to Paperless's trash and is recoverable via `POST /api/trash/{id}/restore` until either the user empties the trash or Paperless's auto-purge fires (`PAPERLESS_EMPTY_TRASH_DELAY`, default 30 days). The endpoint MUST NOT purge Qdrant chunks — those persist until the doc is hard-deleted from the trash. The endpoint's docstring and any user-facing copy SHALL reflect this soft-delete semantics; misleading "permanent deletion" claims SHALL be removed.

#### Scenario: Soft-delete moves the doc to trash
- **WHEN** `DELETE /api/documents/42` is called
- **THEN** the doc appears in `GET /api/trash/` and disappears from `GET /api/library/` and `GET /api/documents/`

#### Scenario: Soft-delete preserves Qdrant chunks
- **WHEN** `DELETE /api/documents/42` is called on a doc that was indexed by RAG
- **THEN** the doc's chunks remain in Qdrant (so a `restore` call leaves the search corpus intact)
