## Why

The current extraction pipeline captures 12 generic fields for every document, but a Rechnung needs a Rechnungsnummer and MwSt breakdown, a Gehaltsabrechnung needs Brutto/Netto/Steuerklasse, and a Kontoauszug needs IBAN and balance — none of which fit the generic schema. Without type-specific fields the database is a permanent document archive with limited structured data per document type, reducing its value as a long-term personal financial and administrative record.

## What Changes

- **New**: Second LLM extraction pass runs after the generic pass, scoped to the detected document type, extracting type-specific fields into a new `document_type_fields` table in the aktenraum DB (JSONB).
- **New**: Python schema registry maps each of the 20 `DocumentType` values to a list of typed field definitions (name, German label, type: string | money | date | month | year).
- **New**: `GET /api/document-types/schema` endpoint serves the full schema registry to the frontend — single source of truth, no drift.
- **New**: `GET /api/documents/{id}/type-fields` and `PATCH /api/documents/{id}/type-fields` endpoints for reading and editing type-specific fields per document.
- **Modified**: Inbox detail (`GET /api/inbox/{id}`) and library detail (`GET /api/documents/{id}/detail`) responses extended to include type-specific fields alongside generic fields.
- **New**: `TypeSpecificFieldsSection` SPA component renders an editable "Typ-spezifische Felder" section below the existing generic fields in the inbox and library review forms. Conditionally rendered when the document type has a schema entry.
- Adding a field to an existing type later requires: one line in the Python schema, one line in the type-specific prompt, redeploy — no DB migration.

## Capabilities

### New Capabilities

- `type-specific-extraction`: Second-pass LLM extraction producing type-specific structured fields per document type, stored in the aktenraum DB.
- `type-schema-api`: Schema registry API endpoint (`GET /api/document-types/schema`) serving typed field definitions per document type.
- `type-fields-api`: Per-document type-specific field read/write API (`GET` and `PATCH /api/documents/{id}/type-fields`).
- `type-fields-ui`: Editable type-specific fields section in the inbox and library review forms.

### Modified Capabilities

## Impact

- **aktenraum-core**: New `TypeSpecificExtraction` Pydantic model; new type-specific prompt builder in `llm/`; schema registry dict in `models/`.
- **auto-tagger**: `tagger.py` triggers pass 2 after pass 1 resolves the document type; pass 2 result written to aktenraum DB via a new HTTP call to aktenraum-api, or stored locally if auto-tagger gets direct DB access.
- **aktenraum-api**: New `document_type_fields` SQLAlchemy model + Alembic migration; new `type_fields` router; inbox and library detail schemas extended.
- **SPA**: New `TypeSpecificFieldsSection` component; schema fetch hook; save/reset wiring reusing existing mutation patterns.
- **No Paperless changes**: Type-specific fields are stored entirely in the aktenraum DB — zero new Paperless custom fields.
