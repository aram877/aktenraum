## ADDED Requirements

### Requirement: Session-cookie JWT authentication
The Node API SHALL authenticate users via an HS256 JWT stored in an httpOnly, `SameSite=Lax` cookie, never exposed to client-side JavaScript, with the same bootstrap-on-empty-users-table behavior as the current service.

#### Scenario: Bootstrap user created on first startup
- **WHEN** the API starts, the `users` table is empty, and `BOOTSTRAP_USERNAME`/`BOOTSTRAP_PASSWORD` are set
- **THEN** exactly one user is created; a second startup with the same configuration does not create a duplicate

#### Scenario: Password hash compatibility with existing users
- **WHEN** a user's password was hashed by the previous Python service
- **THEN** the Node API's bcrypt verification accepts the existing hash without requiring a password reset

### Requirement: Inbox review endpoints
The API SHALL expose paginated listing, per-document detail, field patching, and approve/reject actions for documents tagged `ai-pending`, using the same tag-swap-and-verify idempotency as the current service (re-approving or re-rejecting an already-processed document is a no-op, not an error).

#### Scenario: Idempotent approve
- **WHEN** `POST /api/inbox/{id}/approve` is called on a document already tagged `ai-approved`
- **THEN** the call succeeds and the document's tags are unchanged

### Requirement: Library listing and detail
The API SHALL expose a paginated, filterable (`document_type`, `correspondent`, `date_from`, `date_to`, `text`, `tags`, `ordering`) listing of non-pending documents, excluding `ai-pending` documents server-side, plus a per-document detail/edit endpoint reusing the same field-normalisation boundary as inbox.

#### Scenario: Pending documents never appear in the library
- **WHEN** a document is tagged `ai-pending`
- **THEN** it is excluded from every `/api/library/` response regardless of filters applied

### Requirement: AI find and conversational answer
The API SHALL expose a structured-filter search endpoint (`/api/ai/find`) and a streaming conversational answer endpoint (`/api/ai/answer/stream`) that emits `meta` → repeated `chunk` → `final`/`error` Server-Sent Events, with inline `[Quelle: <id>]` citation markers extracted and cross-checked against the retrieved document set (hallucinated citations dropped).

#### Scenario: Streaming answer emits well-formed SSE events
- **WHEN** a question is submitted to `/api/ai/answer/stream`
- **THEN** the client receives one `meta` event, one or more `chunk` events, and exactly one terminal `final` or `error` event, in that order

#### Scenario: Hallucinated citation is dropped
- **WHEN** the model's streamed answer cites a document id that was not among the retrieved candidates
- **THEN** that id is excluded from the `final` event's citation list

### Requirement: Upload, reprocess, and trash lifecycle
The API SHALL accept multipart document uploads (per-file isolated success/failure reporting), expose a reprocess endpoint that clears all lifecycle tags and pings the worker for immediate re-extraction, and expose a two-step soft-delete/hard-delete trash flow that also purges the document's vector-store chunks on hard delete (best-effort — a Qdrant purge failure does not fail the user-facing request).

#### Scenario: Multi-file upload isolates failures
- **WHEN** an upload request contains 3 files and one fails validation
- **THEN** the response reports per-file status and the 2 valid files still upload successfully

#### Scenario: Hard delete purges vector chunks best-effort
- **WHEN** a document is permanently deleted from trash
- **THEN** its Paperless record and its Qdrant chunks are both removed; if the Qdrant purge fails, the Paperless deletion still succeeds and the failure is logged, not surfaced as a user-facing error

### Requirement: Internal secret-gated endpoints
The API SHALL gate its internal-only endpoints (active auto-approve rules, active LLM model) behind the same `X-Aktenraum-Secret` header mechanism the worker uses, matching `WEBHOOK_SECRET`.

#### Scenario: Internal endpoint rejects missing secret
- **WHEN** `GET /api/settings/active-auto-approve-rules` is called without a matching `X-Aktenraum-Secret` header and `WEBHOOK_SECRET` is configured
- **THEN** the request is rejected
