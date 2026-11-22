# Design

## Decisions

### D1. Component classes for the repeated pieces
Tailwind v4 `@layer components` with `@apply` over the existing tokens: `.card`, `.btn*`, `.field`, `.label-caps`, `.page`, `.page-narrow`. They follow the colour mode automatically (tokens), and utilities still override them (components layer < utilities layer).

### D2. One page header
`PageHeader.vue` (props `eyebrow`, `title`, `subtitle`; slot `actions`, default slot under the title) is the same markup the library uses: an accent eyebrow, a 4xl/5xl serif title, and a muted subtitle. Every top-level page uses it, so the vertical rhythm matches across the app.

### D3. Home composes existing endpoints
- Stat cards: live counts / inbox total / error count / 24 h ingest summary. All already polled by the nav or the home page, so they share the Vue Query cache.
- Newest documents: `useLibrary({ ordering: "-created", page_size: 6 })`.
- Areas: `useTypeFacet()` + `familyCounts()`.

No new API.

### D4. Keep behaviour, change markup
Test IDs, `name` attributes and the German strings asserted in tests stay. Where a page lists documents with a known type (Ask citations, trash, the home page's newest documents), it shows `DocTypeTile`.
