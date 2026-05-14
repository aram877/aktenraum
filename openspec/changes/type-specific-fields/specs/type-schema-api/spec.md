## ADDED Requirements

### Requirement: Schema endpoint returns full registry
`GET /api/document-types/schema` SHALL be an authenticated endpoint that returns the full schema registry as a JSON object mapping each `DocumentType` string value to an ordered list of `FieldDef` objects. The response SHALL be the same shape for every caller and SHALL reflect the current Python `TYPE_FIELD_SCHEMA` constant without DB reads.

#### Scenario: Authenticated request returns schema
- **WHEN** an authenticated user calls `GET /api/document-types/schema`
- **THEN** the response is HTTP 200 with body `{ "Rechnung": [{"name": "rechnungsnummer", "label_de": "Rechnungsnummer", "field_type": "string"}, ...], ... }`

#### Scenario: Unauthenticated request rejected
- **WHEN** `GET /api/document-types/schema` is called without a valid session cookie
- **THEN** the response is HTTP 401

#### Scenario: Sonstiges entry is empty list
- **WHEN** the schema response is parsed
- **THEN** `schema["Sonstiges"]` is `[]`

### Requirement: Schema response is stable and cacheable
The schema endpoint SHALL return a `Cache-Control: private, max-age=3600` header. The schema changes only on redeploy; clients MAY cache it for the session.

#### Scenario: Cache header present
- **WHEN** `GET /api/document-types/schema` returns 200
- **THEN** the response includes `Cache-Control: private, max-age=3600`
