## ADDED Requirements

### Requirement: document_type_fields table stores type-specific data
The aktenraum DB SHALL contain a `document_type_fields` table with columns: `paperless_doc_id` (integer, primary key), `document_type` (varchar), `fields` (JSONB, non-null, default `{}`), `updated_at` (timestamptz, server-updated). The table SHALL be created by an Alembic migration.

#### Scenario: Table created on migration
- **WHEN** `alembic upgrade head` runs on a fresh aktenraum DB
- **THEN** the `document_type_fields` table exists with the correct columns

#### Scenario: Upsert preserves existing keys
- **WHEN** a PATCH is received with a subset of fields
- **THEN** existing keys not present in the patch body are preserved in the JSONB object

### Requirement: GET returns type-specific fields for a document
`GET /api/documents/{id}/type-fields` SHALL return the stored `document_type` and `fields` dict for the given Paperless document ID. If no row exists, it SHALL return HTTP 404.

#### Scenario: Row exists — fields returned
- **WHEN** `GET /api/documents/42/type-fields` is called and a row exists
- **THEN** HTTP 200 with `{ "document_type": "Rechnung", "fields": { "rechnungsnummer": "RE-42" } }`

#### Scenario: No row — 404
- **WHEN** `GET /api/documents/99/type-fields` is called and no row exists for doc 99
- **THEN** HTTP 404

### Requirement: PATCH upserts type-specific fields
`PATCH /api/documents/{id}/type-fields` SHALL accept `{ "fields": { ... } }` and upsert the row for the given document ID. The `document_type` SHALL be inferred from the document's `ai_document_type` Paperless custom field. Unknown field names (not in the schema for the detected type) SHALL be rejected with HTTP 422. Normalisation SHALL run on all values before storage.

#### Scenario: First write creates the row
- **WHEN** `PATCH /api/documents/42/type-fields` is called and no row exists
- **THEN** a new row is inserted with the provided fields and the inferred document type

#### Scenario: Subsequent write merges fields
- **WHEN** `PATCH /api/documents/42/type-fields` is called with `{ "fields": { "iban": "DE89..." } }` and the row already has `{ "rechnungsnummer": "RE-42" }`
- **THEN** the stored row is `{ "rechnungsnummer": "RE-42", "iban": "DE89..." }`

#### Scenario: Unknown field name rejected
- **WHEN** `PATCH /api/documents/42/type-fields` is called with a field name not in the Rechnung schema (e.g. `"kennzeichen"`)
- **THEN** HTTP 422 with a descriptive error

#### Scenario: Unauthenticated request rejected
- **WHEN** either endpoint is called without a valid session cookie
- **THEN** HTTP 401

### Requirement: Inbox and library detail include type-specific fields
`GET /api/inbox/{id}` and `GET /api/documents/{id}/detail` SHALL include a `type_fields` key in their response. Its value SHALL be the `fields` dict from the `document_type_fields` row if one exists, or `null` if no row has been written yet.

#### Scenario: type_fields populated when row exists
- **WHEN** `GET /api/inbox/42` is called and a `document_type_fields` row exists for doc 42
- **THEN** the response body includes `"type_fields": { "rechnungsnummer": "RE-42", ... }`

#### Scenario: type_fields null when no row
- **WHEN** `GET /api/inbox/42` is called and no `document_type_fields` row exists for doc 42
- **THEN** the response body includes `"type_fields": null`
