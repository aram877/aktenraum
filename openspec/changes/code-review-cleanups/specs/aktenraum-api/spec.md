## MODIFIED Requirements

### Requirement: aktenraum-api approves a document via POST /api/inbox/{id}/approve

`POST /api/inbox/{id}/approve` SHALL optionally accept an `InboxFieldUpdate` body. If the body is non-empty, the handler SHALL apply the patch first; then it SHALL replace the `ai-pending` tag with `ai-approved` and remove `ai-low-confidence` if present. After the lifecycle-tag swap succeeds, the handler SHALL fire a best-effort `POST` to the auto-tagger's `/trigger/propagate` webhook so propagation begins immediately rather than waiting for the safety-net poller. The trigger call SHALL be subject to a short bounded timeout (no more than 2 seconds), SHALL include the `X-Aktenraum-Secret` header when `WEBHOOK_SECRET` is configured, and SHALL NOT cause the approve request to fail if it errors, times out, or returns a non-2xx response — failures SHALL be logged at warning level with the document id. When `AUTO_TAGGER_URL` is empty the trigger call SHALL be skipped silently. The response body is the refreshed `InboxDetail`.

#### Scenario: Approve flips the lifecycle tag

- **WHEN** `POST /api/inbox/{id}/approve` is called for a document tagged `ai-pending`
- **THEN** the document is tagged `ai-approved`, the `ai-pending` tag is removed, and the response's `tags` field reflects this

#### Scenario: Approve patches fields then flips the tag

- **WHEN** `POST /api/inbox/{id}/approve` is called with body `{"ai_correspondent": "Telekom"}`
- **THEN** the gateway PATCHes `ai_correspondent="Telekom"` first, then swaps the lifecycle tag, and both changes appear in the response

#### Scenario: Approve also removes ai-low-confidence

- **WHEN** the document carries `ai-pending` and `ai-low-confidence` and Approve is called
- **THEN** the response's `tags` contain neither and contain `ai-approved`

#### Scenario: Approve is idempotent on an already-approved document

- **WHEN** `POST /api/inbox/{id}/approve` is called for a document that is already `ai-approved`
- **THEN** the response is HTTP 200 returning the current `InboxDetail` and no second swap is issued

#### Scenario: Approve fires the propagation trigger after the tag swap

- **WHEN** approve succeeds against a document and `AUTO_TAGGER_URL` is configured
- **THEN** the handler POSTs to `${AUTO_TAGGER_URL}/trigger/propagate` with body `{"document_id": <id>}` and the `X-Aktenraum-Secret` header set when `WEBHOOK_SECRET` is non-empty

#### Scenario: Trigger failure does not fail approve

- **WHEN** the `/trigger/propagate` call errors, times out, or returns a non-2xx status
- **THEN** the approve response is still HTTP 200 with the refreshed `InboxDetail` and the failure is logged at warning level with the document id

#### Scenario: Trigger is skipped when AUTO_TAGGER_URL is empty

- **WHEN** approve succeeds and `AUTO_TAGGER_URL` is the empty string
- **THEN** no outgoing HTTP request is made and approve completes normally
