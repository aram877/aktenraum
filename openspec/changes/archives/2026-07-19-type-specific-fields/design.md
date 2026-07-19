## Context

The aktenraum auto-tagger currently runs one LLM extraction pass per document, writing 12 generic `ai_*` fields into Paperless custom fields. These fields are sufficient for routing, propagation, and search, but carry no type-specific structured data (e.g. Rechnungsnummer, MwSt, IBAN for invoices; Bruttogehalt, Steuerklasse for pay slips).

The aktenraum DB (`aktenraum` Postgres database, managed by aktenraum-api + Alembic) currently holds only the `users` table. It is the natural home for type-specific fields because Paperless custom fields have a hard 128-char limit on `string` type, a finite capacity, and would require ~70 new fields (mostly empty on any given document) to cover all types.

The auto-tagger (Python, asyncio) runs inside Docker and calls Ollama on the host via `host.docker.internal`. The aktenraum-api (FastAPI, asyncpg, SQLAlchemy async) owns the aktenraum DB.

## Goals / Non-Goals

**Goals:**
- Extract type-specific fields in a focused second LLM pass immediately after the generic pass.
- Store results in a new `document_type_fields` table (JSONB) in the aktenraum DB.
- Serve the field schema and per-document values via the aktenraum-api.
- Allow users to view and edit type-specific fields in the inbox and library review forms.
- Make adding a new field to an existing type a single-line Python change with no DB migration.

**Non-Goals:**
- Changing the generic extraction pass or its Paperless custom fields in any way.
- Making type-specific fields searchable via Paperless filters.
- Redesigning the per-type form layout (Option 2); only an additive section below existing fields.
- Backfilling type-specific fields for documents extracted before this feature ships.

## Decisions

### D1 — Storage: aktenraum DB JSONB, not Paperless custom fields

**Decision:** New `document_type_fields` table in the aktenraum DB with a `fields` JSONB column.

**Rationale:** Paperless `string` custom fields have a hard 128-char DB limit. Adding ~70 new fields (one per type-specific concept) would make the Paperless admin unusable and cannot be undone (custom field types are immutable). JSONB allows any field to be added later with zero DB migration — old rows simply lack the new key. The aktenraum SPA never reads Paperless directly; everything goes through aktenraum-api, so keeping data in the aktenraum DB adds no new complexity.

**Alternative considered:** One Paperless custom field per type-specific concept (~70 fields). Rejected because of the 128-char limit, the field-explosion problem, and the fact that most fields would be empty on any given document.

### D2 — Schema registry: Python dict, served via API

**Decision:** A `TYPE_FIELD_SCHEMA: dict[DocumentType, list[FieldDef]]` constant in `aktenraum-core` (or `aktenraum-api`) defines each type's fields. `FieldDef` is a small dataclass: `name: str`, `label_de: str`, `field_type: Literal["string", "money", "date", "month", "year"]`. Exposed as `GET /api/document-types/schema` returning `dict[str, list[FieldDef]]`.

**Rationale:** Single source of truth — backend and frontend cannot drift. Adding a field is one line of Python + redeploy. No DB-driven schema table needed for a personal DMS that evolves deliberately.

**Alternative considered:** DB-driven schema (a `document_type_field_defs` table). Rejected as overkill — hot-adding fields without a redeploy is not a requirement, and a DB table adds a migration and an extra query path for schema reads.

### D3 — Extraction: two-pass, auto-tagger calls aktenraum-api to persist

**Decision:** After pass 1 completes and the document type is known, the auto-tagger runs pass 2 with a short, type-focused prompt. Pass 2 result is a flat `dict[str, str | None]` (raw strings; the API normalises on write). The auto-tagger POSTs this dict to `PATCH /api/documents/{id}/type-fields` on the aktenraum-api.

**Rationale:** Auto-tagger already calls Paperless directly; calling aktenraum-api is the same pattern and avoids giving the auto-tagger its own DB connection. Pass 2 skips for `Sonstiges` (no schema entry). Failures in pass 2 are logged and do not affect the lifecycle tag — generic extraction is complete by then, so the document is not left in a broken state.

**Alternative considered:** Single combined prompt (one LLM call). Rejected because a single prompt covering all 20 types × 5 fields = ~100 field definitions is too long and produces lower accuracy on gemma4:26b, particularly for conditional schema logic. Two short, focused prompts are more reliable.

**Alternative considered:** Auto-tagger writes directly to the aktenraum DB. Rejected to keep the aktenraum DB owned exclusively by aktenraum-api (single writer, Alembic-managed). Avoids connection pool conflicts and keeps the auto-tagger dependency surface small.

### D4 — Pass 2 prompt structure

Each type gets a compact prompt (< 20 lines) that:
1. States the document type in German.
2. Lists the fields to extract with their type and a one-line description.
3. Asks for a JSON object with exactly those keys (null for not found).
4. Includes the same OCR-fragment awareness rules from the generic system prompt.

The prompt is built by a `build_type_specific_prompt(doc_type, content)` function in `aktenraum-core`.

### D5 — API endpoints

```
GET  /api/document-types/schema
     → { "Rechnung": [FieldDef, ...], "Gehaltsabrechnung": [...], ... }

GET  /api/documents/{id}/type-fields
     → { "document_type": "Rechnung", "fields": { "rechnungsnummer": "RE-42", ... } }
     → 404 if no row exists for this doc_id

PATCH /api/documents/{id}/type-fields
      body: { "fields": { "rechnungsnummer": "RE-42", ... } }
      → upserts the row; merges fields (existing keys not in body are preserved)
      → 422 if field names not in schema for the detected type
```

Inbox detail (`GET /api/inbox/{id}`) and library detail (`GET /api/documents/{id}/detail`) include a `type_fields` key in their response, populated from the DB row (null if not yet extracted).

### D6 — Normalisation on write

Money fields: same `_normalize_monetary` used for generic fields.
Date fields: same `_normalize_date`.
Month fields: normalise to `YYYY-MM` (strip day if present).
Year fields: normalise to `YYYY` (4-digit string).
String fields: strip whitespace, truncate at 500 chars (no Paperless limit applies).

Normalisation runs in the `PATCH /api/documents/{id}/type-fields` handler so both LLM writes and user edits go through the same path.

### D7 — Frontend: additive section, same edit/save UX

`TypeSpecificFieldsSection` is a new React component that:
- Fetches the schema via `GET /api/document-types/schema` (cached in React Query, refetched rarely).
- Reads the current values from the detail response (`type_fields` key).
- Renders an input per field: text input for string/money/year, date picker for date, month input for month.
- Save and Reset buttons reuse the existing pattern from the generic fields form.
- Rendered below the generic fields section in both `Inbox/$id` and `Library/$id` routes.
- Hidden when the document type is `Sonstiges` or has no schema entry.

## Risks / Trade-offs

**[Pass 2 LLM accuracy]** Small/medium local models may extract type-specific fields less reliably than generic fields (fewer training examples for German-specific schemas like Steuerklasse).
→ Mitigation: Short, focused prompts per type. All fields are editable in the UI. Pass 2 failures are non-fatal.

**[Auto-tagger → aktenraum-api coupling]** Auto-tagger now depends on aktenraum-api being up to persist type-specific fields. If aktenraum-api is down, pass 2 results are lost.
→ Mitigation: Pass 2 failure is logged but does not affect lifecycle tags. The 30s poller does not retry pass 2 (only re-runs pass 1 on docs without lifecycle tags). User can trigger reprocess manually.

**[Schema/data drift]** If a field is removed from the schema, old DB rows still have it. The API returns unknown keys as-is (they are visible in `type_fields` but not rendered by the UI since the schema doesn't list them).
→ Mitigation: Acceptable for a personal DMS. Adding fields is the common case; removing them is rare.

**[No backfill]** Documents extracted before this feature ships will have no `document_type_fields` row.
→ Mitigation: User can click Reprocess on any document to trigger both passes. A backfill script (out of scope for this change) could iterate all propagated docs.

## Migration Plan

1. Add Alembic migration: create `document_type_fields` table.
2. Deploy aktenraum-api (migration runs automatically on startup via `alembic upgrade head`).
3. Deploy auto-tagger (rebuilt with pass 2 logic). Existing documents are unaffected until reprocessed.
4. Deploy nginx/SPA with `TypeSpecificFieldsSection`.

No data migration needed. Rollback: remove auto-tagger pass 2 code, drop `document_type_fields` table via Alembic downgrade.

## Open Questions

- Should pass 2 run for documents that were auto-approved (bypassed inbox)? **Yes** — pass 2 runs regardless of lifecycle routing; it fires after pass 1 completes.
- Should the aktenraum-api `PATCH /api/documents/{id}/type-fields` require the `document_type` in the body (to validate field names), or infer it from the existing `ai_document_type` Paperless field? **Infer from Paperless** — avoids the auto-tagger needing to re-send the type, and keeps the endpoint simple.
