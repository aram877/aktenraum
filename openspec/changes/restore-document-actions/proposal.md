## Why

CLAUDE.md lists delete-to-trash, the `wichtig` star, duplicate handling and type-specific fields as implemented, and the API has tested endpoints for all of them, but neither the Angular nor the Nuxt SPA ever got the UI. The Node worker port also dropped the Python worker's second LLM pass that extracted type-specific fields, so no document processed since the cutover has `Gesamtbetrag`, `Laufzeit` etc. — which also starves Ask's precomputed totals. The maintainer chose to build all four (2026-10-01).

## What Changes

- Library detail: ★ star toggle, two-click "Löschen" (moves to Papierkorb, back to `/library`), duplicate panel ("Mögliches Duplikat von #N" links + "Kein Duplikat") on `ai-duplicate` docs, editable type-specific fields section.
- Inbox detail: ★ star toggle and the type-specific fields section.
- `useApi` gains `del`; new composables in `useDocumentActions.ts`.
- API: `PATCH /api/documents/:id/type-fields` treats an explicit `null` as "clear this field" (previously ignored).
- Worker: after routing, a non-fatal second LLM pass extracts the type's fields (`TYPE_FIELD_SCHEMA`) and PATCHes them to the API with the shared secret; only non-empty values are sent.

## Capabilities

### New Capabilities
- `document-actions`: per-document star, delete, duplicate resolution and type-specific field editing in the SPA, plus automatic type-field extraction.

### Modified Capabilities

## Impact

- `apps/web/app/{composables/useApi.ts,composables/useDocumentActions.ts,utils/type-fields.ts,components/{StarToggle,DuplicatePanel,TypeFieldsSection}.vue,pages/library/[id].vue,pages/inbox/[id].vue}`
- `services/aktenraum-api/src/type-fields/type-fields.service.ts`
- `services/auto-tagger/src/{type-fields,extract,main}.ts`
- One extra LLM call per non-`Sonstiges` document during extraction.
