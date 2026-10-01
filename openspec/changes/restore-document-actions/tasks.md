## 1. SPA

- [x] 1.1 `useApi.del`; `useDocumentActions.ts` (star, delete, duplicates, schema, type-field patch)
- [x] 1.2 `StarToggle`, `DuplicatePanel`, `TypeFieldsSection`; `utils/type-fields.ts`
- [x] 1.3 Wire into library and inbox detail pages
- [x] 1.4 Tests (`tests/nuxt/document-actions.spec.ts`, `tests/unit/type-fields.spec.ts`)

## 2. API

- [x] 2.1 Explicit `null` clears a type field
- [x] 2.2 Route tests for star, delete, dismiss, type fields

## 3. Worker

- [x] 3.1 Port the type-specific pass (`type-fields.ts`), wire into `processDocument`
- [x] 3.2 Tests

## 4. Verify and document

- [x] 4.1 lint, build, test, api + web typecheck
- [x] 4.2 e2e (20/20, `type_specific_pass_done` with rechnungsnummer + gesamtbetrag) + live rebuild
- [x] 4.3 CLAUDE.md
- [x] 4.4 Session note at commit time
