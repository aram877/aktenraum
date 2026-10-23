## ADDED Requirements

### Requirement: Library status dropdown
The library page SHALL offer a "Status" dropdown (Alle · Fehler · Wartet auf KI · Wird übertragen · Fertig · Abgelehnt) persisted as `?status=` in the URL, and an "In Prüfung" entry that navigates to `/library?tab=review`.

#### Scenario: bookmark the failed view
- **WHEN** the user opens `/library?status=error`
- **THEN** the dropdown shows "Fehler" and only failed documents are listed

#### Scenario: changing status resets paging
- **WHEN** the user is on page 4 and picks a status
- **THEN** the URL has `page=1`

### Requirement: Bulk reprocess button
When the Fehler filter is active and the list is non-empty, the library SHALL show "Alle fehlerhaften erneut verarbeiten (N)" with a two-click confirm; on completion it SHALL show the result ("N neu gestartet · M fehlgeschlagen") and invalidate the library and live-count queries.

#### Scenario: confirm required
- **WHEN** the user clicks the button once
- **THEN** no request is sent and the button asks for confirmation

### Requirement: Nav error pill
The nav bar SHALL show a red "N Fehler" pill when `errors > 0`, linking to `/library?status=error`. It sits next to the in-flight pill, so it is visible on mobile without opening the drawer (a badge inside the Bibliothek link cannot itself be a link). When the live stream has not pushed yet, the count comes from a polled `GET /api/library/?status=error&page_size=1`.

#### Scenario: no errors
- **WHEN** `errors` is 0, or it is missing from the live-counts payload and the polled count is 0
- **THEN** no error pill is rendered

### Requirement: Activity page
The SPA SHALL provide `/activity` ("Aktivität" in the nav) showing a summary row, the processed e-mails, and the imported files with source, outcome, links and live processing badges, with a 1 / 7 / 30-day range selector.

#### Scenario: duplicate row links to the original
- **WHEN** an item has `outcome=duplicate`
- **THEN** the row reads "Duplikat von #<id> · <title>" and links to `/library/<id>`

#### Scenario: live progress
- **WHEN** any item is running or a new document has not reached a final state
- **THEN** the page refetches every 5 seconds, and stops once all items are settled

#### Scenario: empty window
- **WHEN** nothing was imported in the selected range
- **THEN** the page shows "Keine Importe im gewählten Zeitraum"

### Requirement: Home summary card
The home page SHALL show the last-24-hours import summary and the current error count, linking to `/activity` and `/library?status=error`.
