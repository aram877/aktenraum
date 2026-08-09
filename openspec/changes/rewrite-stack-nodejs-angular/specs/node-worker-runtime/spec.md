## ADDED Requirements

### Requirement: Event-driven extraction with polling safety net
The Node worker SHALL accept extraction triggers via an internal HTTP webhook (`POST /trigger/extract`, secret-gated when `WEBHOOK_SECRET` is set) and SHALL also run a periodic poller (default 30s) that enqueues any document missing all lifecycle tags, so a missed webhook is never a permanent miss.

#### Scenario: Webhook enqueues immediately
- **WHEN** `POST /trigger/extract` is called with a valid document id and, if configured, a matching `X-Aktenraum-Secret` header
- **THEN** the document id is enqueued for extraction without waiting for the next poll cycle

#### Scenario: Poller catches a missed webhook
- **WHEN** a document has no lifecycle tags and no webhook was received for it
- **THEN** the next poll cycle enqueues it for extraction

#### Scenario: Invalid secret is rejected
- **WHEN** `WEBHOOK_SECRET` is configured and the request's `X-Aktenraum-Secret` header does not match
- **THEN** the webhook call is rejected and the document is not enqueued

### Requirement: Race-safe dequeue
The worker SHALL re-fetch a document's current lifecycle tags immediately before processing it, and SHALL skip processing (without error) if any lifecycle tag is already present, to handle the case where the webhook and poller both enqueued the same document.

#### Scenario: Duplicate enqueue is a no-op
- **WHEN** a document is enqueued twice (once by webhook, once by poller) and the first run has already tagged it `ai-pending`
- **THEN** the second dequeue detects the existing lifecycle tag and skips processing without raising an error

### Requirement: Confidence-based lifecycle routing
The worker SHALL fetch per-document-type auto-approve rules (`enabled`, `min_confidence`) from the API over HTTP with an in-process cache (default 60s TTL), and route each extracted document to lifecycle tags according to: enabled + confidence at or above threshold → `ai-approved` + `ai-auto-approved`; enabled + below threshold → `ai-pending` with reason `confidence_below_min`; type disabled → `ai-pending` with reason `type_disabled`; rule store unreachable at cold start with no cache populated → `ai-pending` with reason `rules_unreachable_fail_closed` (fail closed, never auto-approve without a confirmed rule).

#### Scenario: Auto-approve fires when both gates pass
- **WHEN** a document's type has `enabled=true` and `min_confidence=0.9`, and the extraction confidence is `0.95`
- **THEN** the document is tagged `ai-approved` and `ai-auto-approved`

#### Scenario: Fail-closed on unreachable rule store at cold start
- **WHEN** the worker starts up and the API's rule endpoint is unreachable, with no cached rule set yet
- **THEN** every extracted document is tagged `ai-pending` with reason `rules_unreachable_fail_closed`, never auto-approved

### Requirement: Propagation to native Paperless fields
The worker SHALL watch for documents tagged `ai-approved`, look up or create the corresponding native Paperless Correspondent/DocumentType/Tag entities by exact-name match, and PATCH the document's native `correspondent`, `document_type`, `created_date`, and `tags` fields in a single request, then tag the result `ai-propagated` on success or `ai-propagation-error` on failure (no automatic retry).

#### Scenario: Successful propagation
- **WHEN** a document tagged `ai-approved` has valid `ai_correspondent`, `ai_document_type`, and `ai_issue_date` values
- **THEN** the worker creates/reuses the matching native entities, PATCHes the document's native fields, removes `ai-approved`, and adds `ai-propagated`

#### Scenario: Propagation failure is not silently retried
- **WHEN** the native-field PATCH fails for any reason
- **THEN** the document is tagged `ai-propagation-error` and is not re-attempted automatically

### Requirement: Duplicate detection
The worker SHALL, after every successful propagation, compare the new document against other `ai-propagated` documents sharing the same correspondent, and tag both sides of a match `ai-duplicate` when they share `ai_document_type` and `ai_issue_date` AND either their monetary amounts are within 0.01 of each other or their reference numbers overlap. A document carrying `ai-duplicate-dismissed` SHALL be excluded from future duplicate comparisons.

#### Scenario: Matching pair is flagged
- **WHEN** two propagated documents from the same correspondent share document type, issue date, and monetary amount within 0.01
- **THEN** both documents are tagged `ai-duplicate`

#### Scenario: Dismissed document is not re-flagged
- **WHEN** a document carries `ai-duplicate-dismissed`
- **THEN** subsequent propagations do not compare new documents against it and do not re-add `ai-duplicate` to it

### Requirement: RAG indexing on propagation
The worker SHALL enqueue a document for RAG indexing once it reaches `ai-propagated`, chunk and embed its content, and upsert it into the vector store with denormalised metadata (doc type, correspondent, tags, created date). Indexing failure SHALL tag the document `ai-index-error` (auxiliary, not a lifecycle tag); a subsequent successful index SHALL clear that tag.

#### Scenario: Indexing failure self-heals
- **WHEN** indexing fails for a document (tagged `ai-index-error`) and a later re-index of the same document succeeds
- **THEN** the `ai-index-error` tag is removed
