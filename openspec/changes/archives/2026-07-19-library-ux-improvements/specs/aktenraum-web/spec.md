## ADDED Requirements

### Requirement: SPA Library page exposes a Sortierung dropdown persisted to URL state

The `/library` page SHALL render a `<select>` control labelled "Sortierung" in the Library header (alongside the existing filter inputs). The dropdown SHALL offer six options matching the backend allowlist:

- `Erstellt (neueste zuerst)` → `-created` (default)
- `Erstellt (älteste zuerst)` → `created`
- `Geändert (neueste zuerst)` → `-modified`
- `Geändert (älteste zuerst)` → `modified`
- `Titel (A → Z)` → `title`
- `Titel (Z → A)` → `-title`

The selected value SHALL be persisted to the URL as `?ordering=<value>` via TanStack Router's `navigate({ search })`. The page MUST read the ordering back from URL state on load so a bookmarked URL reproduces the same sort. Unknown / malformed values from URL state SHALL fall back to the `-created` default.

#### Scenario: Selecting an ordering updates the URL and the list
- **WHEN** the user opens `/library` (no ordering in URL) and selects "Titel (A → Z)" from the Sortierung dropdown
- **THEN** the URL becomes `/library?ordering=title`, the `GET /api/library/?ordering=title` request fires, and the rendered rows appear in title-ascending order

#### Scenario: Bookmarked sort URL renders the sorted list
- **WHEN** the user navigates directly to `/library?ordering=-modified`
- **THEN** the Sortierung dropdown reads "Geändert (neueste zuerst)" and the rows are sorted by modified-time descending

#### Scenario: Unknown ordering value falls back to default
- **WHEN** the user navigates to `/library?ordering=__bogus__`
- **THEN** the dropdown reads "Erstellt (neueste zuerst)", the URL is normalised to remove the bogus param, and the list is sorted by `-created`

### Requirement: SPA renders a processing spinner on pinned in-flight Library rows

For each Library row whose `is_processing` flag is `true` (set server-side on the page-1 prepended rows), the SPA SHALL render the existing `ProcessingBadge` spinner in place of (or alongside) the row's normal lifecycle badge. The row layout SHALL otherwise be identical to non-processing rows so the user can still click through to the detail page.

#### Scenario: Pinned row shows the spinner
- **WHEN** `GET /api/library/?page=1` returns a first row with `is_processing=true`
- **THEN** that row renders the `ProcessingBadge` spinner (and not the static "Wartet auf KI" badge)

#### Scenario: Non-pinned rows are unchanged
- **WHEN** the user pages through `/library?page=2` or scrolls past the pinned row
- **THEN** no row renders the spinner; lifecycle badges render as today
