## ADDED Requirements

### Requirement: SPA exposes a /trash route with paginated trashed-document list

The SPA SHALL register a lazy route at `/trash` rendering a page titled "Papierkorb". The page SHALL fetch `GET /api/trash/` (default page 1, page size 20) and display one row per trashed document with: title, suggested correspondent (native or `ai_correspondent`), suggested document type (native or `ai_document_type`), `deleted_at` formatted in German short date, and a "noch N Tage" hint computed from `deleted_at` and the hard-coded 30-day default for `PAPERLESS_EMPTY_TRASH_DELAY`. Empty state SHALL render "Papierkorb ist leer" with no action buttons.

#### Scenario: Trash page renders pending docs oldest-first
- **WHEN** the user navigates to `/trash` and the trash has three docs with deleted_at 2026-05-10, 2026-05-12, 2026-05-15
- **THEN** the page shows three rows in that order with the 2026-05-10 row at the top

#### Scenario: Empty trash shows an explicit empty state
- **WHEN** `/trash` is opened and `GET /api/trash/?page_size=1` returns `{count: 0, …}`
- **THEN** the page shows the text "Papierkorb ist leer" and renders no action buttons

### Requirement: SPA restores a trashed document via a per-row Wiederherstellen action

Each row in `/trash` SHALL include a "Wiederherstellen" button that posts to `POST /api/trash/{id}/restore` and on success invalidates the `trash`, `library`, `inbox`, `in-flight`, and per-doc-preview TanStack Query caches. The button SHALL show a pending state during the request and an inline error message (German prose, derived from the API response detail when present) on failure.

#### Scenario: Restore success removes the row and shrinks the badge
- **WHEN** the user clicks "Wiederherstellen" on a row and the API returns 204
- **THEN** the row disappears from `/trash`, the nav-bar trash badge decrements by one (or hides at zero), and the doc reappears in `/library`

#### Scenario: Restore failure shows an inline error
- **WHEN** the API returns a non-2xx response (e.g. 502)
- **THEN** the row stays visible, displays the API's error detail (or a generic fallback) inline, and the rest of the page remains usable

### Requirement: SPA hard-deletes a trashed document via a per-row Endgültig löschen action

Each row in `/trash` SHALL include a destructive "Endgültig löschen" button with an inline two-step confirm ("Wirklich löschen?" → "Ja, endgültig löschen"). On confirm the SPA SHALL post to `POST /api/trash/{id}/delete` and on 204 invalidate the `trash` and `library` caches. The button MUST be visually distinguished as destructive (red text or contrast).

#### Scenario: Endgültig löschen with confirm hard-deletes the doc
- **WHEN** the user clicks "Endgültig löschen", confirms the second step, and the API returns 204
- **THEN** the row disappears from `/trash`, the nav badge decrements, and the doc does NOT reappear in `/library`

#### Scenario: Endgültig löschen first click does not delete
- **WHEN** the user clicks "Endgültig löschen" once but does not confirm
- **THEN** the SPA shows the second-step confirm but does NOT issue an API request

### Requirement: SPA empties the entire trash via a top-bar Papierkorb leeren action

The `/trash` page SHALL render a "Papierkorb leeren" button in the page header when the trash has at least one document. Clicking it SHALL open a full-screen modal: "Wirklich alle N Dokumente endgültig löschen? Dies kann nicht rückgängig gemacht werden." with buttons "Abbrechen" and "Ja, alle endgültig löschen". On confirm the SPA SHALL post to `POST /api/trash/empty`, render a toast on success ("N Dokumente endgültig gelöscht"), and invalidate `trash` and `library` caches. The button SHALL NOT be rendered when the trash is empty.

#### Scenario: Empty trash button is hidden when trash is empty
- **WHEN** the trash has zero documents
- **THEN** the "Papierkorb leeren" button is not rendered

#### Scenario: Empty trash flow hard-deletes everything and reports the count
- **WHEN** the trash has 7 documents, the user clicks "Papierkorb leeren", confirms the modal, and the API returns `{"emptied": 7}`
- **THEN** the trash list renders the empty state, the nav badge hides, and a toast says "7 Dokumente endgültig gelöscht"

### Requirement: SPA nav-bar shows a Papierkorb link with a count badge

The SPA's primary navigation SHALL include a "Papierkorb" link routing to `/trash`. The link SHALL display a small count badge fed by `GET /api/trash/?page_size=1` and refetched on a 30-second `staleTime` (matching the existing in-flight pill cadence). When the trash is empty the badge SHALL be hidden, not rendered as "0".

#### Scenario: Badge shows when the trash has at least one doc
- **WHEN** the trash has 3 documents
- **THEN** the nav-bar Papierkorb link shows a badge with the text "3"

#### Scenario: Badge hides when the trash is empty
- **WHEN** the trash has zero documents
- **THEN** the nav-bar Papierkorb link renders without a badge

### Requirement: SPA Löschen confirm copy reflects soft-delete semantics

The existing "Löschen" action on `DocumentPreviewModal` (and any other place a Delete button lives in the SPA) SHALL display German copy that accurately describes the soft-delete behaviour, e.g. "Wird in den Papierkorb verschoben — 30 Tage wiederherstellbar". The copy MUST NOT claim the deletion is permanent or unrecoverable.

#### Scenario: Delete confirm uses soft-delete copy
- **WHEN** the user opens the delete confirm on any doc preview modal
- **THEN** the rendered confirm text mentions the trash (Papierkorb) and a recovery window, not "unwiderruflich" or "permanent"
