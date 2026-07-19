## Why

The `/find` page was removed 2026-06-01 on the assumption it overlapped with Ask AI, but the use cases are distinct: Find is document retrieval ("where is my Hochschulzeugnis?"), Ask is Q&A over document content ("what is my net salary?"). Ask AI handles retrieval queries poorly — it denies or suppresses results when the question is a statement rather than a question, leaving users with no useful output.

## What Changes

- Re-add `apps/web/src/routes/Find.tsx` (the Dokumente finden page)
- Re-add `apps/web/src/components/FilterChips.tsx` (active-filter chip strip)
- Re-add `useFind`, `findByQuery`, `findByFilter`, `FindResponse`, `FindInput` exports to `apps/web/src/lib/ai.ts`
- Re-add `/find` lazy route to `apps/web/src/router.tsx`
- Add a Find nav entry to `apps/web/src/components/Nav.tsx` (icon + tooltip, same pattern as existing nav items)

No backend changes — `POST /api/ai/find` is intact and tested.

## Capabilities

### New Capabilities

- `find-page`: Document retrieval via natural-language query; shows matched docs as cards with active-filter chips the user can remove to broaden the search.

### Modified Capabilities

- `navigation`: Nav gains a Find entry (MagnifyingGlass icon) between Ask AI and Library.

## Impact

- Frontend only: `apps/web/src/routes/Find.tsx`, `apps/web/src/components/FilterChips.tsx`, `apps/web/src/lib/ai.ts`, `apps/web/src/router.tsx`, `apps/web/src/components/Nav.tsx`
- No backend changes
- No new dependencies
- Bundle: Find page is lazy-loaded (its own chunk), same as every other route
