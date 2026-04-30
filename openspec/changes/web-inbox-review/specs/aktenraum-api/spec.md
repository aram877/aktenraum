## ADDED Requirements

### Requirement: aktenraum-api exposes a paginated inbox list at /api/inbox/

The service SHALL expose `GET /api/inbox/`, auth-gated. Returns paginated `ai-pending` documents in oldest-first order. Query params: `page` (≥1, default 1) and `page_size` (1..100, default 20).

Response body shape:

```json
{
  "results": [{ "id": int, "title": str, "created": "YYYY-MM-DD",
                "ai_correspondent": str|null, "ai_document_type": str|null,
                "ai_issue_date": "YYYY-MM-DD"|null, "ai_monetary_amount": str|null,
                "ai_confidence": float|null, "low_confidence": bool }],
  "total": int, "page": int, "page_size": int
}
```

#### Scenario: List requires authentication

- **WHEN** `GET /api/inbox/` is called without the auth cookie
- **THEN** the response is HTTP 401

#### Scenario: List returns ai-pending docs in oldest-first order

- **WHEN** Paperless has three `ai-pending` documents created on 2024-01-01, 2024-02-01, 2024-03-01 and `GET /api/inbox/` is called
- **THEN** the response's `results` list contains those three documents in chronological order (oldest first), `total=3`

#### Scenario: low_confidence flag is true iff the doc has the ai-low-confidence tag

- **WHEN** `GET /api/inbox/` returns a document carrying both `ai-pending` and `ai-low-confidence` tags
- **THEN** the corresponding result item has `low_confidence=true`; documents without the tag have `low_confidence=false`

### Requirement: aktenraum-api exposes a single-document review payload at /api/inbox/{id}

`GET /api/inbox/{id}` SHALL return the full review payload, auth-gated. The response includes every `ai_*` custom field by name (matching Paperless), the document's content excerpt (first ~2000 chars), and the full tag-name list.

#### Scenario: Detail returns every ai_* field by name

- **WHEN** `GET /api/inbox/9` is called against a document with all 12 custom fields populated
- **THEN** the response body contains keys `ai_document_type`, `ai_correspondent`, `ai_issue_date`, `ai_due_date`, `ai_expiry_date`, `ai_monetary_amount`, `ai_reference_numbers`, `ai_suggested_tags`, `ai_summary_de`, `ai_confidence`, `ai_backend`, `ai_model` plus `id`, `title`, `created`, `tags`, `content_excerpt`

#### Scenario: Detail 404s when the document is not in the inbox

- **WHEN** `GET /api/inbox/{id}` is called for a document id that does not exist
- **THEN** the response is HTTP 404 with `detail` indicating the document was not found

### Requirement: aktenraum-api accepts partial updates to the AI fields at PATCH /api/inbox/{id}

`PATCH /api/inbox/{id}` SHALL accept an `InboxFieldUpdate` body where every field is optional. The handler SHALL run `aktenraum_core.paperless.normalisers` against monetary, date, and string fields before sending to Paperless. The response is the refreshed `InboxDetail`, so the SPA can read the normalised values without a second GET.

#### Scenario: PATCH normalises German date input to ISO

- **WHEN** `PATCH /api/inbox/{id}` is called with `{"ai_issue_date": "01.12.2024"}`
- **THEN** the gateway is asked to write `2024-12-01` and the response's `ai_issue_date` is `"2024-12-01"`

#### Scenario: PATCH normalises German monetary input to ISO format

- **WHEN** `PATCH /api/inbox/{id}` is called with `{"ai_monetary_amount": "1.234,56 EUR"}`
- **THEN** the gateway is asked to write `EUR1234.56` and the response's `ai_monetary_amount` is `"EUR1234.56"`

#### Scenario: PATCH truncates strings exceeding the Paperless 128-char limit

- **WHEN** `PATCH /api/inbox/{id}` is called with `{"ai_correspondent": "<200 chars>"}`
- **THEN** the gateway is asked to write the value truncated to the 128-char boundary with an ellipsis, and the response surfaces the truncated value

#### Scenario: Empty PATCH body is a no-op

- **WHEN** `PATCH /api/inbox/{id}` is called with `{}`
- **THEN** no Paperless PATCH is issued and the response returns the current `InboxDetail` unchanged

### Requirement: aktenraum-api approves a document via POST /api/inbox/{id}/approve

`POST /api/inbox/{id}/approve` SHALL optionally accept an `InboxFieldUpdate` body. If the body is non-empty, the handler SHALL apply the patch first; then it SHALL replace the `ai-pending` tag with `ai-approved` and remove `ai-low-confidence` if present. The response body is the refreshed `InboxDetail`.

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

### Requirement: aktenraum-api rejects a document via POST /api/inbox/{id}/reject

`POST /api/inbox/{id}/reject` SHALL replace the `ai-pending` tag with `ai-rejected`, removing `ai-low-confidence` if present. No field changes are applied.

#### Scenario: Reject flips the lifecycle tag

- **WHEN** `POST /api/inbox/{id}/reject` is called for a doc tagged `ai-pending`
- **THEN** the document is tagged `ai-rejected`, `ai-pending` is removed, and the response's `tags` reflect this

#### Scenario: Reject does not touch ai_* custom fields

- **WHEN** Reject is called against a doc with populated `ai_correspondent` and `ai_summary_de`
- **THEN** those custom fields remain unchanged after the call

### Requirement: aktenraum-api streams the PDF preview at /api/inbox/{id}/preview

`GET /api/inbox/{id}/preview` SHALL stream the Paperless preview through a `StreamingResponse` with `Content-Type: application/pdf` and `Cache-Control: private, max-age=300`. The endpoint is auth-gated by the SPA cookie. The Paperless API token SHALL NOT appear in any response header.

#### Scenario: Preview requires the auth cookie

- **WHEN** `GET /api/inbox/{id}/preview` is called without the cookie
- **THEN** the response is HTTP 401

#### Scenario: Preview proxies bytes with the right content type

- **WHEN** Paperless returns a PDF stream for the configured doc id
- **THEN** the SPA-facing response has `Content-Type: application/pdf`, `Cache-Control: private, max-age=300`, and the raw bytes match the upstream stream

#### Scenario: Paperless auth failure surfaces as 502

- **WHEN** Paperless returns 401 to the gateway's preview request
- **THEN** the API returns HTTP 502 with a generic detail and the API token does not appear in the response body

### Requirement: aktenraum-api's gateway extends with get_document, patch_document_custom_fields, swap_lifecycle_tag, stream_preview

The `PaperlessGateway` SHALL expose four new operations:

- `get_document(id) -> dict` — full doc payload (content + custom_fields).
- `patch_document_custom_fields(id, name_to_value: dict)` — resolves field ids, normalises values via `aktenraum_core.paperless.normalisers`, sends a single PATCH.
- `swap_lifecycle_tag(id, *, remove: list[str], add: list[str])` — single tag-array PATCH.
- `stream_preview(id) -> AsyncIterator[bytes]` — opens an httpx stream against `/api/documents/{id}/preview/`.

Each method SHALL fail loudly on Paperless auth errors via `PaperlessAuthError` (already defined).

#### Scenario: patch_document_custom_fields normalises at the boundary

- **WHEN** `patch_document_custom_fields(id, {"ai_issue_date": "01.12.2024", "ai_monetary_amount": "1.234,56 EUR"})` is called
- **THEN** the request to Paperless contains `2024-12-01` and `EUR1234.56` for those fields

#### Scenario: swap_lifecycle_tag removes named tags and adds named tags atomically

- **WHEN** `swap_lifecycle_tag(id, remove=["ai-pending", "ai-low-confidence"], add=["ai-approved"])` is called against a doc tagged `[ai-pending, ai-low-confidence, sonstiges]`
- **THEN** exactly one PATCH is sent with `tags=[<ai-approved-id>, <sonstiges-id>]`
