# Design

## Context

Nuxt 4 SPA, Tailwind v4 with an `@theme` token block in `app/assets/css/main.css`. Every component uses token classes (`bg-canvas`, `text-ink-muted`, `border-hairline`, `text-accent`), so retheming the tokens restyles everything. Strict CSP: `font-src 'self' data:`, `style-src 'self' 'unsafe-inline'`, so external font CDNs are out. The approved mockup is the reference (canvas "aktenraum Redesign").

## Decisions

### D1. Retheme tokens in place, keep the token names
Renaming tokens would touch every file. The names stay and the values change: `canvas` = page, `surface` = cards, `surface-raised` = chips, `hairline` = borders, `ink*` = text, `accent` = the sealing-wax red for small labels and focus rings. Primary buttons use `bg-ink text-canvas` (the mockup's black buttons). `ink-subtle` / `ink-faint` are darkened so 12 px grey text keeps 4.5:1 on the warm canvas. A new `--font-serif` token adds the `font-serif` class.

### D2. Colour per area, icon + code per type
27 hues cannot be told apart; 9 area colours can, and the icon and code distinguish types within an area. White on every fill is at least 4.8:1; each area's ink on its tint is at least 4.5:1. Bußgeldbescheid sits with Kfz under Mobilität (traffic). Icons are single-path 24×24 strokes kept in the same file, with no icon library dependency.

### D3. Area filter = several document types
The library API filters by one native document type. An area is a list of type names, so the API accepts a repeated `document_type` and sends `document_type__id__in`. The SPA keeps `?family=<key>` in the URL and derives the type list from it, so URLs stay short. `?document_type=` alone still works, and a type wins over its family.

### D4. Status label only when something needs attention
`classify()` stays the single source of labels. The row shows a dot + label for warning/danger/info states and for in-flight documents. "Verarbeitet" / "Auto-genehmigt" show nothing, because a finished document is the normal case.

### D5. Tags: star visible, the rest "+N"
`userFacingTags` + `sortTagsImportantFirst` are unchanged. A row shows ★ when `wichtig` is present and a "+N" chip for the others, with `title` holding the full list. The sidebar tag cloud becomes a tag search inside "Weitere Filter" that lists matching tags only (or the 12 most used when the search is empty).

### D6. Preview panel uses the existing detail query
At 1024 px and wider, clicking a row selects it, and the panel loads `useDocumentDetail(selected)` (cached by Vue Query, so opening the detail page afterwards is instant). The title stays a real `NuxtLink`, so keyboard and middle-click open the document directly.

### D7. Month groups
Rows are grouped by `created` month ("November 2026", `Intl.DateTimeFormat("de-DE")`) only when the ordering is by `created`; other orderings are ungrouped.

## Risks / Trade-offs

- Font files add roughly 150 KB (two variable woff2 files, Latin subset), cached by the browser.
- Tests assert on markup (table vs card list, `select[name=document_type]`); they are updated with the new structure.
