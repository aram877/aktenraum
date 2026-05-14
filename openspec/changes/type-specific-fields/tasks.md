## 1. Schema Registry (aktenraum-core)

- [x] 1.1 Add `FieldDef` dataclass to `packages/aktenraum-core/src/aktenraum_core/models/extraction.py` with fields `name: str`, `label_de: str`, `field_type: Literal["string", "money", "date", "month", "year"]`
- [x] 1.2 Add `TYPE_FIELD_SCHEMA: dict[DocumentType, list[FieldDef]]` constant in a new file `packages/aktenraum-core/src/aktenraum_core/models/type_schema.py` with all 20 document types and their fields as specified in the proposal
- [x] 1.3 Export `FieldDef` and `TYPE_FIELD_SCHEMA` from `packages/aktenraum-core/src/aktenraum_core/models/__init__.py`

## 2. Type-Specific Prompt Builder (aktenraum-core)

- [x] 2.1 Add `build_type_specific_prompt(doc_type: DocumentType, content: str) -> str` in a new file `packages/aktenraum-core/src/aktenraum_core/llm/type_prompt.py` — builds a short focused prompt listing the schema fields for the given type with types, German descriptions, and OCR-fragment awareness rule
- [x] 2.2 Add `extract_type_specific(doc_type, content, backend) -> dict[str, str | None]` function that calls `build_type_specific_prompt`, invokes the LLM backend, and parses the returned JSON into a flat dict
- [x] 2.3 Export the new functions from `packages/aktenraum-core/src/aktenraum_core/llm/__init__.py`

## 3. DB Migration (aktenraum-api)

- [x] 3.1 Add `DocumentTypeFields` SQLAlchemy model to `services/aktenraum-api/src/aktenraum_api/db/models.py` with columns: `paperless_doc_id` (Integer, primary key), `document_type` (String), `fields` (JSONB, default `{}`), `updated_at` (DateTime with server `now()` on insert and update)
- [x] 3.2 Generate Alembic migration: `uv run alembic --config services/aktenraum-api/alembic.ini revision --autogenerate -m "add document_type_fields table"` and verify the generated migration file
- [x] 3.3 Confirm migration runs cleanly against the live DB: `docker compose exec aktenraum-api alembic upgrade head`

## 4. Type Fields API (aktenraum-api)

- [x] 4.1 Create `services/aktenraum-api/src/aktenraum_api/type_fields/` package with `__init__.py`, `router.py`, `schemas.py`, `service.py`
- [x] 4.2 Implement `TypeFieldsService` in `service.py`: `get(doc_id)` returns the row or None; `upsert(doc_id, fields)` merges fields into the JSONB column; infers `document_type` from Paperless `ai_document_type` custom field via `PaperlessGateway`; runs normalisation per field type before storing
- [x] 4.3 Implement `GET /api/documents/{id}/type-fields` in `router.py` — returns 200 with `{document_type, fields}` or 404
- [x] 4.4 Implement `PATCH /api/documents/{id}/type-fields` in `router.py` — validates field names against `TYPE_FIELD_SCHEMA` for the detected type (422 on unknown names), calls `TypeFieldsService.upsert`, returns updated fields
- [x] 4.5 Implement `GET /api/document-types/schema` in `router.py` — returns the full `TYPE_FIELD_SCHEMA` serialised to JSON with `Cache-Control: private, max-age=3600`
- [x] 4.6 Register the new router in `services/aktenraum-api/src/aktenraum_api/main.py` with prefix `/api`

## 5. Extend Inbox and Library Detail Responses (aktenraum-api)

- [x] 5.1 Add `type_fields: dict[str, str] | None` to the inbox detail schema (`services/aktenraum-api/src/aktenraum_api/inbox/schemas.py`)
- [x] 5.2 Extend `services/aktenraum-api/src/aktenraum_api/inbox/service.py` to fetch the `document_type_fields` row and include it in the detail response (`null` if no row)
- [x] 5.3 Add `type_fields: dict[str, str] | None` to the library/document detail schema and extend the service similarly

## 6. Auto-Tagger Pass 2 (auto-tagger)

- [x] 6.1 Add `AKTENRAUM_API_URL` setting to `services/auto-tagger/src/auto_tagger/config.py` (default `http://aktenraum-api:8002`) and add to `docker/auto-tagger.env.example`
- [x] 6.2 Extend `services/auto-tagger/src/auto_tagger/tagger.py`: after `patch_document_ai_fields` succeeds and `document_type != Sonstiges`, call `extract_type_specific` then POST the result to `PATCH {AKTENRAUM_API_URL}/api/documents/{id}/type-fields` via aiohttp; catch and log all exceptions without re-raising
- [x] 6.3 Rebuild and redeploy auto-tagger: `docker compose up -d --build auto-tagger`

## 7. Frontend — Schema Hook and TypeSpecificFieldsSection (SPA)

- [x] 7.1 Add `getDocumentTypeSchema()` API function to `apps/web/src/lib/` that calls `GET /api/document-types/schema`
- [x] 7.2 Add `useDocumentTypeSchema()` React Query hook with `staleTime: 60 * 60 * 1000` (1 hour)
- [x] 7.3 Add `getTypeFields(id)` and `patchTypeFields(id, fields)` API functions
- [x] 7.4 Create `apps/web/src/components/TypeSpecificFieldsSection.tsx` component that: reads schema for the document's type; renders labelled inputs by field type (`text`, `date`, `month`, or text with YYYY constraint); tracks local edit state; exposes Save and Reset buttons (disabled when no changes); calls `patchTypeFields` on save; hides entirely for Sonstiges or types with empty schema
- [x] 7.5 Mount `TypeSpecificFieldsSection` in the inbox review route (`apps/web/src/routes/Inbox.$id.tsx` or equivalent) below the generic fields form, passing `documentId` and `documentType`
- [x] 7.6 Mount `TypeSpecificFieldsSection` in the library review route (`apps/web/src/routes/Library.$id.tsx` or equivalent) in the same position

## 8. Tests

- [x] 8.1 Add unit tests for `build_type_specific_prompt` — verify prompt contains correct field names for each type, and does not contain fields from other types
- [x] 8.2 Add unit tests for `TypeFieldsService.upsert` — merge behaviour, normalisation, unknown-field rejection
- [x] 8.3 Add tests for `GET /api/document-types/schema` — shape, Sonstiges empty list, cache header
- [x] 8.4 Add tests for `GET` and `PATCH /api/documents/{id}/type-fields` — 404 on missing row, merge semantics, 422 on unknown field, normalisation applied
- [x] 8.5 Add tests for updated inbox detail response — `type_fields` key present, null when no row

## 9. Rebuild and Smoke Test

- [x] 9.1 Run full test suite: `uv run pytest` — all tests pass
- [x] 9.2 Rebuild API image and restart: `docker compose up -d --build aktenraum-api`
- [x] 9.3 Rebuild nginx/SPA: `docker compose up -d --build nginx`
- [x] 9.4 Upload a test Rechnung, verify pass 2 fires in auto-tagger logs, verify type-specific fields appear in the inbox review form
- [x] 9.5 Edit a type-specific field in the UI, save, reload — verify the value persists
