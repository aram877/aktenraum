## ADDED Requirements

### Requirement: Full route parity with the existing SPA
The Angular application SHALL implement every route currently served by the React SPA — Home, Ask, Library (with the review tab), Library detail, Upload, Scan, Trash, Settings, Login — against the Node API's REST/SSE contract, with lazy-loaded route chunks matching the current code-splitting boundaries (e.g. the scan page's PDF-composition dependency stays out of the main bundle).

#### Scenario: Legacy inbox URL still redirects
- **WHEN** a user navigates to `/inbox`
- **THEN** the app redirects to `/library?tab=review`, matching the current redirect-only behavior

### Requirement: Query-key and invalidation parity
The Angular app's data-fetching layer SHALL use the same query-key shape and cache-invalidation rules documented for the React app (e.g. approving a document invalidates both the inbox and library caches; starring a document updates the cached document without a full refetch where the current app does so).

#### Scenario: Approve invalidates both cached lists
- **WHEN** a document is approved from the review tab
- **THEN** both the inbox query cache and the library query cache are invalidated so the document disappears from review and appears in the library on next render

### Requirement: Streaming answer consumption
The Ask page SHALL consume `/api/ai/answer/stream` via SSE, rendering tokens as they arrive and resolving citation cards from the `final` event, matching the current token-by-token rendering behavior.

#### Scenario: Answer renders incrementally
- **WHEN** a question is submitted on the Ask page
- **THEN** answer text appears progressively as `chunk` events arrive, not all at once after the full answer completes

### Requirement: Mobile responsiveness parity
The Angular app SHALL preserve the current responsive breakpoints and behaviors: nav collapses to a drawer below the `md` breakpoint, list views swap from table to card layout below `md`, two-pane detail views swap to a tabbed PDF/form toggle below `lg`, and the document preview modal renders full-screen below `sm`.

#### Scenario: Library list becomes cards on mobile
- **WHEN** the viewport width is below the `md` breakpoint
- **THEN** the library list renders as a card-per-document layout instead of a table

### Requirement: Mobile scan flow parity
The Scan page SHALL invoke the device camera via a file input, support per-page reorder/rotate/crop/delete, compose the result into an A4-portrait PDF client-side, and upload through the existing document-upload endpoint with no dedicated scan-upload endpoint on the backend.

#### Scenario: Composed scan uploads through the standard endpoint
- **WHEN** a user finishes arranging scanned pages and confirms upload
- **THEN** the client-composed PDF is submitted to the same `/api/documents/upload` endpoint used by the Upload page, with no scan-specific backend route involved
