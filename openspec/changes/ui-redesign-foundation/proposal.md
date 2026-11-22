# Proposal

## Why

The library page is hard to scan: every row prints all of its tags (unbounded), the sidebar prints the whole tag cloud (~500 tags on the live install), rows grow with their tag count, and the document type is plain grey text, so a Rechnung, an Arztbrief and a Bußgeldbescheid look the same. The whole SPA uses one pale-blue palette with no hierarchy. The maintainer approved a redesign mockup on 2026-11-22 (light, warm editorial look; a tile with icon + code per document type; whole app in scope). This change builds the foundation of that redesign and applies it to the pages the mockup covered.

## What Changes

- **Design tokens**: the Tailwind theme moves to warm paper (`#f6f2ea` canvas, `#fffdf9` surface, `#1c1917` ink, sealing-wax `#8a3324` accent). Because every page uses the tokens, the whole app takes on the new look at once. Fonts are self-hosted (Inter variable for text, Newsreader variable for headings, via `@fontsource-variable/*`), with no external requests, so the CSP and offline desktop installs keep working.
- **Document type system** (`app/utils/doc-types.ts`): the 27 types sorted into 9 areas (Geld, Arbeit, Amt & Steuer, Wohnen, Verträge, Gesundheit, Mobilität, Persönlich, Sonstiges), each area with a fill / tint / ink colour, each type with a 2-letter code and an icon. Unknown or missing types map to Sonstiges. `DocTypeTile.vue` renders it at three sizes (24 / 40 / 72 px).
- **Library archive**:
  - Header with a serif title and the count.
  - Area chips with counts (from the type facet). Choosing an area shows its types as sub-chips. `?family=` / `?document_type=` stay in the URL.
  - One toolbar: search, Status, sorting, and a "Weitere Filter" disclosure (correspondent, dates, space, tags with a search box instead of the full cloud).
  - Rows grouped by month, fixed height: tile · title · type + correspondent · ★ and "+N" tags (full list on hover) · date · one status label shown only when something needs attention.
  - On wide screens a preview panel shows the selected document's key data.
  - Mobile uses the same rows.
- **API**: `GET /api/library/` accepts `document_type` more than once and filters with `document_type__id__in` (needed for area filters).
- **Review tab**: same compact rows with tiles.
- **Detail pages** (`/library/[id]`, `/inbox/[id]`): a header band tinted in the area colour with the 72 px tile, a serif title and meta.
- **Navigation**: serif wordmark, underlined active link, quieter status pills.
- `ProcessingBadge` gains a `dot` variant for rows.

## Non-goals

- Layout passes over home, Ask, upload, activity, trash, settings, Akten and Geteilt. They get the new tokens and fonts, but their layouts stay; a follow-up change (`ui-redesign-pages`) covers them.
- A dark mode.
- Changing which data the library returns. Amounts aren't in `LibraryItem`, so the list shows no key amount; the preview panel loads the detail.
