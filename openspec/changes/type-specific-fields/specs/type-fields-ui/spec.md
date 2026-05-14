## ADDED Requirements

### Requirement: TypeSpecificFieldsSection renders below generic fields
The `TypeSpecificFieldsSection` React component SHALL render an editable section labelled "Typ-spezifische Felder" below the existing generic fields in both the `/inbox/$id` and `/library/$id` review routes. It SHALL be hidden when the document type is `Sonstiges` or has no entry in the schema (empty list).

#### Scenario: Section visible for Rechnung
- **WHEN** the review form opens for a document with `document_type = Rechnung`
- **THEN** a "Typ-spezifische Felder" section appears below the generic fields showing Rechnung-specific inputs

#### Scenario: Section hidden for Sonstiges
- **WHEN** the review form opens for a document with `document_type = Sonstiges`
- **THEN** no type-specific section is rendered

#### Scenario: Section hidden while type unknown
- **WHEN** the document detail loads but `document_type` is not yet resolved (null)
- **THEN** no type-specific section is rendered

### Requirement: Schema fetched once and cached
The SPA SHALL fetch `GET /api/document-types/schema` once per session using React Query with a long `staleTime` (≥ 1 hour). The schema SHALL NOT be re-fetched on every page navigation.

#### Scenario: Schema cached after first fetch
- **WHEN** the user navigates between inbox items
- **THEN** only one network request is made to `/api/document-types/schema` per session

### Requirement: Each field rendered with appropriate input type
- `string` fields SHALL render as a text input.
- `money` fields SHALL render as a text input with placeholder `EUR0.00`.
- `date` fields SHALL render as a date input (`type="date"`).
- `month` fields SHALL render as a month input (`type="month"`).
- `year` fields SHALL render as a text input with placeholder `YYYY` and maxlength 4.
- Each field SHALL display its `label_de` as the visible label.
- Empty/absent fields SHALL render with an empty input (not `"null"` or `"undefined"`).

#### Scenario: Money field shows placeholder
- **WHEN** `nettobetrag` has no stored value
- **THEN** the input renders empty with placeholder `EUR0.00`

#### Scenario: Populated field shows stored value
- **WHEN** `rechnungsnummer` has stored value `"RE-2024-0042"`
- **THEN** the text input shows `RE-2024-0042`

### Requirement: Save and Reset follow existing generic fields UX
The type-specific section SHALL have Save and Reset buttons that follow the same interaction pattern as the generic fields form. Save SHALL call `PATCH /api/documents/{id}/type-fields` with the current input values. Reset SHALL restore inputs to the last saved values. Both buttons SHALL be disabled when no changes have been made.

#### Scenario: Save persists edited values
- **WHEN** the user edits `rechnungsnummer` and clicks Save
- **THEN** `PATCH /api/documents/{id}/type-fields` is called with `{ "fields": { "rechnungsnummer": "<new value>" } }` and the section shows the updated value

#### Scenario: Reset discards unsaved changes
- **WHEN** the user edits a field and then clicks Reset without saving
- **THEN** the input reverts to the previously saved value

#### Scenario: Save disabled when no changes
- **WHEN** the type-specific fields section is opened with no edits made
- **THEN** the Save button is disabled
