## ADDED Requirements

### Requirement: Settings page exposes the Auto-Genehmigung section

The SPA SHALL render an "Auto-Genehmigung" section on `/settings` that lets an authenticated user view and edit per-`DocumentType` auto-approve rules. The section MUST display all 26 `DocumentType` enum values in a single table.

#### Scenario: Authenticated user opens Settings

- **WHEN** a logged-in user navigates to `/settings`
- **THEN** the page renders a section titled "Auto-Genehmigung"
- **AND** the section contains a table with 26 rows, one per `DocumentType`
- **AND** each row shows: German document-type name (from the existing `apps/web/src/lib/doc-types.ts` mapping), `enabled` checkbox, `min_confidence` numeric input, last-updated timestamp + username (or "—" if never updated)

#### Scenario: Rows are pre-populated from the server

- **WHEN** the Auto-Genehmigung section mounts
- **THEN** the SPA fetches `GET /api/settings/auto-approve` and binds the response into the table
- **AND** the `enabled` checkbox and `min_confidence` input reflect the server-side values per row
- **AND** the rows are sorted alphabetically by document-type name

#### Scenario: min_confidence input constrains values

- **WHEN** a user types into the `min_confidence` input
- **THEN** the input enforces `step=0.05`, `min=0.00`, `max=1.00`
- **AND** values outside the range trigger native browser validation feedback

### Requirement: Bulk-toggle controls and single-save semantics

The Auto-Genehmigung section SHALL provide bulk-toggle helpers ("Alle aktivieren" / "Alle deaktivieren") and a single Save button that submits the full rule set in one PUT request.

#### Scenario: "Alle aktivieren" flips every enabled checkbox to true

- **WHEN** the user clicks the "Alle aktivieren" button
- **THEN** every row's `enabled` checkbox becomes checked in local UI state
- **AND** the rows are marked dirty (Save button becomes enabled)
- **AND** no HTTP request is sent yet

#### Scenario: "Alle deaktivieren" flips every enabled checkbox to false

- **WHEN** the user clicks the "Alle deaktivieren" button
- **THEN** every row's `enabled` checkbox becomes unchecked
- **AND** the rows are marked dirty

#### Scenario: Reset discards unsaved edits

- **WHEN** the user has made local edits AND clicks "Zurücksetzen"
- **THEN** the table re-renders from the last fetched server state
- **AND** the Save button becomes disabled

#### Scenario: Save submits the full set via PUT

- **WHEN** the user clicks "Speichern"
- **THEN** the SPA sends `PUT /api/settings/auto-approve` with `{rules: [...26 entries...]}` reflecting the current local state
- **AND** the request body covers exactly the 26 `DocumentType` enum values (no rows skipped)

#### Scenario: Save success refreshes the table

- **WHEN** the PUT responds `200 OK`
- **THEN** the table re-binds to the response payload
- **AND** the `updated_at` and `updated_by` columns reflect the new save
- **AND** a green German confirmation toast appears ("Auto-Genehmigung gespeichert")
- **AND** the Save button returns to disabled state

#### Scenario: Save failure surfaces server error

- **WHEN** the PUT responds with a 4xx error
- **THEN** the local state is preserved (the user does not lose their edits)
- **AND** a red German error toast appears with the server's detail message
- **AND** the Save button is re-enabled

### Requirement: Low-confidence values surface a visible warning

When the user saves a row with `min_confidence < 0.70`, the SPA SHALL display a yellow indicator next to that row to make low thresholds visible by design.

#### Scenario: Saving a value below 0.70 shows the warning

- **WHEN** the user sets `min_confidence=0.50` on the `Ausweis` row and clicks Save
- **THEN** after a successful PUT, the `Ausweis` row renders a yellow "Achtung: niedriger Schwellwert" indicator next to the value

#### Scenario: Raising the value clears the warning

- **WHEN** the user raises `min_confidence` from `0.50` to `0.80` on the `Ausweis` row and Saves
- **THEN** the yellow indicator on that row is no longer rendered

#### Scenario: Indicator is informational only, not a block

- **WHEN** the user sets `min_confidence=0.10` and clicks Save
- **THEN** the PUT proceeds (the indicator does NOT prevent the save)
- **AND** the warning indicator renders after the save completes
