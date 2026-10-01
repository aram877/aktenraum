## ADDED Requirements

### Requirement: Star a document
The library and inbox detail pages SHALL offer a toggle that adds or removes the `wichtig` tag.

#### Scenario: star then unstar
- **WHEN** the user clicks the star on an unstarred document and then again
- **THEN** `POST` and then `DELETE /api/documents/:id/star` are sent and the toggle reflects the tag

### Requirement: Move a document to the trash
The library detail page SHALL move a document to the Papierkorb after a confirming second click and return to the library.

#### Scenario: delete
- **WHEN** the user clicks "Löschen" twice
- **THEN** `DELETE /api/documents/:id` is sent and the page navigates to `/library`

### Requirement: Resolve duplicates
A document tagged `ai-duplicate` SHALL show links to its duplicate candidates and a "Kein Duplikat" action.

#### Scenario: dismiss
- **WHEN** the user clicks "Kein Duplikat"
- **THEN** `POST /api/documents/:id/dismiss-duplicate` is sent

### Requirement: Edit type-specific fields
Detail pages SHALL render the fields defined for the document's type and save only changed values, sending `null` for an emptied field, which the API SHALL treat as clearing it.

#### Scenario: change one field, clear another
- **WHEN** the user edits `gesamtbetrag` and empties `iban`, then saves
- **THEN** the PATCH contains exactly those two keys, `iban: null`, and `iban` is removed from the stored fields

### Requirement: Extract type-specific fields automatically
After routing a non-`Sonstiges` document the worker SHALL extract its type-specific fields and store the non-empty ones via the API; a failure SHALL NOT change the document's lifecycle state.

#### Scenario: invoice
- **WHEN** a Rechnung is extracted
- **THEN** its non-empty type fields are PATCHed to `/api/documents/:id/type-fields`

#### Scenario: second pass fails
- **WHEN** the type-field LLM call throws
- **THEN** the document keeps its routing tags and `type_specific_pass_failed` is logged
