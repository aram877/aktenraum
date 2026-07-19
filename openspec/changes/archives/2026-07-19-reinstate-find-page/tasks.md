## 1. Restore lib/ai.ts exports

- [x] 1.1 Add `FindResponse` type (`filter`, `results`, `explanation`, `total`) to `apps/web/src/lib/ai.ts`
- [x] 1.2 Add `FindInput` type (`{query: string} | {filter: SearchFilter}`) to `apps/web/src/lib/ai.ts`
- [x] 1.3 Add `findByQuery` and `findByFilter` fetch functions to `apps/web/src/lib/ai.ts`
- [x] 1.4 Add `useFind` mutation hook to `apps/web/src/lib/ai.ts`

## 2. Restore components

- [x] 2.1 Restore `apps/web/src/components/FilterChips.tsx` (chip strip for active SearchFilter)
- [x] 2.2 Restore `apps/web/src/routes/Find.tsx` (page component with form, FilterChips, result cards)

## 3. Wire up routing and nav

- [x] 3.1 Add MagnifyingGlass icon to `apps/web/src/components/Icons.tsx` if not already present
- [x] 3.2 Add lazy import for `Find` and `/find` route to `apps/web/src/router.tsx`
- [x] 3.3 Add Find nav item (icon + tooltip + mobile label) to `apps/web/src/components/Nav.tsx`, positioned between Ask AI and Library

## 4. Verify

- [x] 4.1 Run `pnpm --filter @aktenraum/web build` — no type errors, no missing imports
- [x] 4.2 Start dev server (`task web:dev`) and confirm `/find` loads, a query returns results, filter chips appear and are removable
