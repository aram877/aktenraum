## ADDED Requirements

### Requirement: Auto-tagger accepts propagation triggers via HTTP webhook

The service SHALL expose `POST /trigger/propagate` on its internal HTTP listener (the same listener that already serves `/trigger/extract`, `/health`, and `/processing`). The handler SHALL accept a JSON body of the form `{"document_id": <int>}` and enqueue the id onto an internal `asyncio.Queue` drained by the propagation worker. The handler SHALL return HTTP 202 with `{"queued": <id>}` on success, 400 on a malformed body, 401 when `WEBHOOK_SECRET` is set and the `X-Aktenraum-Secret` header is missing or wrong, and 503 when the queue is full. The handler SHALL NOT call propagation inline; processing happens in the dedicated worker.

#### Scenario: Webhook enqueues a doc id and returns 202
- **WHEN** `POST /trigger/propagate` is called with `{"document_id": 42}` and a matching secret (or `WEBHOOK_SECRET` is empty)
- **THEN** the response is HTTP 202 with body `{"queued": 42}` and the propagation worker picks up doc 42 within one event-loop iteration

#### Scenario: Webhook rejects a missing or wrong secret
- **WHEN** `POST /trigger/propagate` is called and `WEBHOOK_SECRET` is set but the request omits `X-Aktenraum-Secret` or sends a non-matching value
- **THEN** the response is HTTP 401 and nothing is enqueued

#### Scenario: Webhook rejects a malformed body
- **WHEN** `POST /trigger/propagate` is called with invalid JSON, a body that is not an object, or a `document_id` that is not an integer
- **THEN** the response is HTTP 400 and nothing is enqueued

#### Scenario: Webhook returns 503 when the queue is at capacity
- **WHEN** the propagation queue is full at the moment of the request
- **THEN** the response is HTTP 503 with body `{"error": "queue full, retry shortly"}` and the safety-net poller is relied upon to catch the doc

### Requirement: Propagation is queue-based with the poller as the safety net

The service SHALL drive propagation through an `asyncio.Queue[int]` (the "propagation queue") drained by a dedicated worker task. Both the new webhook and the existing 30-second poller SHALL enqueue ids onto this queue rather than calling `process_approved_document` inline. The worker SHALL re-verify lifecycle tags on dequeue and skip ids that are no longer `ai-approved` (defence against webhook/poller race). The poller SHALL remain enabled so missed webhook calls (auto-tagger restart between approve and the next poll, network blip, secret mismatch) still result in propagation.

#### Scenario: Webhook path completes propagation in under a second under typical load
- **WHEN** an `ai-approved` doc id is enqueued via the webhook on an otherwise idle worker
- **THEN** propagation completes (the doc is `ai-propagated` or `ai-propagation-error` at Paperless) within one second of the webhook returning 202

#### Scenario: Poller catches a missed webhook
- **WHEN** the auto-tagger was restarting at the moment aktenraum-api fired the webhook, and the doc remains `ai-approved` in Paperless
- **THEN** the next poll cycle enqueues the doc onto the propagation queue and propagation completes

#### Scenario: Webhook and poller race-enqueue the same doc
- **WHEN** both the webhook and a poll cycle enqueue the same doc id within a single worker drain
- **THEN** the worker processes the first occurrence, and the second dequeue finds the doc no longer `ai-approved` and is a no-op
