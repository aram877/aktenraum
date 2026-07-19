## ADDED Requirements

### Requirement: Natural-language document search
The SPA SHALL provide a `/find` page where the user enters a natural-language query and receives a list of matching documents retrieved via `POST /api/ai/find`.

#### Scenario: Successful search
- **WHEN** the user submits a non-empty query on `/find`
- **THEN** the system calls `POST /api/ai/find` with `{query}` and displays matched document cards and an explanation string

#### Scenario: Empty query blocked
- **WHEN** the user submits an empty or whitespace-only query
- **THEN** the form does not submit and no API call is made

#### Scenario: Loading state
- **WHEN** a search request is in flight
- **THEN** the submit button shows "…" and is disabled

#### Scenario: API error
- **WHEN** `POST /api/ai/find` returns an error
- **THEN** the error detail is displayed in a red error block below the form

### Requirement: Active filter chips
The page SHALL display a strip of removable filter chips reflecting the `SearchFilter` returned by the backend, so the user can narrow or broaden the active search without retyping.

#### Scenario: Chip per active filter
- **WHEN** the search result includes a `filter` with non-null fields (e.g. `document_type`, `correspondent`, `date_from`, `date_to`, `text`)
- **THEN** one chip is shown per non-null field, labelled with the field name and value

#### Scenario: One chip per tag
- **WHEN** the search result filter includes a non-empty `tags` array
- **THEN** one chip is shown per tag entry

#### Scenario: Remove scalar chip
- **WHEN** the user clicks a scalar chip (e.g. document_type)
- **THEN** the system re-runs the search with that field set to null in the filter

#### Scenario: Remove tag chip
- **WHEN** the user clicks a tag chip
- **THEN** the system re-runs the search with that tag removed from the filter's tags array

#### Scenario: No active filters
- **WHEN** all filter fields are null/empty
- **THEN** the chip strip shows "Keine Filter — alles wird angezeigt."

### Requirement: Result count and document cards
The page SHALL display the total match count and render one `DocumentCard` per result.

#### Scenario: Results shown
- **WHEN** the search returns results
- **THEN** the page shows "N Treffer" (or "N Treffer (zeige M)" if paginated) above the card list

#### Scenario: Zero results
- **WHEN** the search returns zero results
- **THEN** the page shows "Keine Treffer."
