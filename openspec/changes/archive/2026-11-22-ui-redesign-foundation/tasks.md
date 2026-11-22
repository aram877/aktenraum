# Tasks

## 1. Foundation

- [x] 1.1 Tokens + fonts: warm theme in `main.css`, `--font-serif`, self-hosted `@fontsource-variable/inter` + `@fontsource-variable/newsreader`; verify `pnpm --filter @aktenraum/web build` and that no external font URL is emitted.
- [x] 1.2 `utils/doc-types.ts` (areas, types, icons, `docTypeStyle`, `FAMILIES`, `familyTypes`) + `components/DocTypeTile.vue` (sm/md/lg); verify with unit tests (all 27 types covered, unknown → Sonstiges, every type in exactly one area).

## 2. API

- [x] 2.1 Library `document_type` repeated → `document_type__id__in` (single keeps `document_type__id`; none known → empty result); verify with route tests.

## 3. Library

- [x] 3.1 Archive tab rewrite: header, area + type chips, toolbar with "Weitere Filter", month-grouped compact rows, ★ / +N, status label, preview panel (lg), pagination, bulk bar; `family` in the URL; verify with updated `library.spec.ts`.
- [x] 3.2 Review tab: compact rows with tiles; verify the review specs still pass.

## 4. Detail + nav

- [x] 4.1 `DocumentHeader.vue` (tinted band, 72 px tile, title, meta) on `/library/[id]` and `/inbox/[id]`; verify `detail-pages.spec.ts`.
- [x] 4.2 AppNav restyle; row status via the pure `rowStatus()` helper in `utils/library.ts` (instead of a `ProcessingBadge` variant — `ProcessingBadge` stays for Ask / other pages); verify `nav.spec.ts`.

## 5. Checks

- [x] 5.1 CLAUDE.md (SPA notes), session note; `pnpm -r lint`, `pnpm -r build`, api + web typecheck, `pnpm -r test`; `task build` and check the pages in the browser.
