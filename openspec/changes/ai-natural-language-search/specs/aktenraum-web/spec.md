## ADDED Requirements

### Requirement: aktenraum-web exposes an /ask page for natural-language search

The SPA SHALL register a `/ask` route, guarded by the same `beforeLoad` auth check as `/`. Unauthenticated users hitting `/ask` SHALL be redirected to `/login`. The page SHALL contain:

- A search input with a German placeholder ("Was suchst du?").
- A submit button.
- A region for the explanation panel ("Ich habe verstanden: …").
- A region for the editable filter chips.
- A region for the result list.

#### Scenario: Authenticated user navigates to /ask

- **WHEN** a logged-in user navigates to `/ask`
- **THEN** the page renders without redirect and shows the empty form state

#### Scenario: Unauthenticated user is redirected

- **WHEN** an anonymous browser navigates to `/ask`
- **THEN** the SPA redirects to `/login`

### Requirement: aktenraum-web sends the user's query through the /api/ai/ask endpoint

Submitting the form SHALL call `POST /api/ai/ask` via the shared axios instance (with `withCredentials: true`). The mutation result SHALL hydrate three independent regions: the explanation panel (text), the filter-chip row (one chip per populated `SearchFilter` field), and the result list.

#### Scenario: Successful query renders all three regions

- **WHEN** the user submits a query that returns a non-empty `AskResponse`
- **THEN** the explanation panel shows `response.explanation`, the chip row shows one chip per non-null filter field, and the result list shows one card per `response.results` item

#### Scenario: 503 on missing token is shown inline

- **WHEN** the API responds 503 with `detail` mentioning the missing Paperless token
- **THEN** the page shows the German error message inline and does NOT render an empty result list

#### Scenario: Empty results render an empty-state message

- **WHEN** the API responds 200 with `results=[]`
- **THEN** the page shows a German empty-state ("Keine Treffer.") rather than an empty placeholder

### Requirement: aktenraum-web allows the user to edit filter chips and re-run search without invoking the LLM

Each populated `SearchFilter` field SHALL render as a clickable chip showing the field label and value. Clicking a chip SHALL clear that field and re-run `POST /api/ai/ask` with the resulting `filter` payload (no `query`), so the LLM is not invoked again. The explanation panel SHALL update to reflect the new filter.

#### Scenario: Clearing a chip removes the field and re-runs the search

- **WHEN** a result set is showing with chips for `document_type` and `date_from`/`date_to`, and the user clicks the `document_type` chip
- **THEN** the SPA POSTs `/api/ai/ask` with `{filter: {date_from, date_to}}` (no `query`, no `document_type`), updates the result list, and updates the explanation panel

#### Scenario: Clearing the last chip yields the broadest search

- **WHEN** the user clears the last remaining chip on a previous result
- **THEN** the SPA POSTs `/api/ai/ask` with `{filter: {}}` and renders the resulting "no constraints" explanation alongside the broadest result list

### Requirement: aktenraum-web Home shows a navigation link to /ask

The home view SHALL render a link or button to `/ask` so users discover the feature. The link SHALL be visible whenever the user is logged in.

#### Scenario: Home renders an /ask link for authenticated users

- **WHEN** a logged-in user lands on `/`
- **THEN** the home view renders a clickable link to `/ask` labelled "Ask AI" (or German equivalent)
