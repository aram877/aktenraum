## ADDED Requirements

### Requirement: aktenraum-web exposes an /inbox list view of pending documents

The SPA SHALL register a `/inbox` route, guarded by the same `beforeLoad` auth check the home and ask routes use. Unauthenticated users SHALL be redirected to `/login`. The page SHALL render a table of `ai-pending` documents pulled from `GET /api/inbox/`, sorted oldest-first. Each row SHALL show: title, AI document type guess, AI correspondent guess, AI issue date, monetary amount, and confidence (as a badge or numeric). Rows tagged low-confidence SHALL be visually distinguished.

#### Scenario: Authenticated user navigates to /inbox

- **WHEN** a logged-in user navigates to `/inbox`
- **THEN** the page renders without redirect and shows one row per pending doc returned by the API

#### Scenario: Empty queue shows an empty-state

- **WHEN** the API returns `total=0`
- **THEN** the page shows a German empty-state message (no rows rendered)

#### Scenario: Low-confidence rows are highlighted

- **WHEN** any row's `low_confidence` is true
- **THEN** that row renders with a visible distinguishing element (border / colour) so the user can spot it without expanding

### Requirement: aktenraum-web exposes a two-pane review at /inbox/{id}

The SPA SHALL register a parametric route `/inbox/$id`, auth-guarded. The page SHALL render two columns:

- **Left**: a PDF iframe whose `src` is `/api/inbox/{id}/preview`.
- **Right**: a scrollable form binding to the 12 `ai_*` fields from `InboxDetail`, plus an Approve button (primary) and a Reject button.

`ai_confidence`, `ai_backend`, `ai_model` SHALL render read-only.

#### Scenario: Review renders the iframe and the form

- **WHEN** the user navigates to `/inbox/9` and the API returns the detail
- **THEN** the page renders the PDF iframe pointing at `/api/inbox/9/preview` and a form with each editable `ai_*` field pre-populated from the detail

#### Scenario: Approve sends the dirty form values then advances to the next doc

- **WHEN** the user changes `ai_correspondent`, presses Approve, and the call succeeds
- **THEN** the SPA POSTs `/api/inbox/9/approve` with `{ai_correspondent: <new value>}`, the cached inbox-list query is invalidated, and the user is navigated to the next pending doc id (or back to `/inbox` if none remain)

#### Scenario: Reject does not send field edits

- **WHEN** the user changes `ai_correspondent` and presses Reject
- **THEN** the SPA POSTs `/api/inbox/9/reject` with no body, the field change is discarded, and the user is navigated to the next pending doc

### Requirement: aktenraum-web supports keyboard shortcuts on the review page

The review page SHALL bind the following shortcuts when no input/textarea/contenteditable element is focused:

- `a` → Approve current doc
- `r` → Reject current doc
- `j` → next pending doc
- `k` → previous pending doc
- `Escape` → return to `/inbox`

#### Scenario: Pressing 'a' approves when no input is focused

- **WHEN** the review page is rendered and the user's focus is not on a form field, and the user presses 'a'
- **THEN** the SPA performs the same action as clicking Approve

#### Scenario: Shortcut keys do nothing when an input is focused

- **WHEN** the user's focus is inside a text input and they press 'a'
- **THEN** the keystroke types 'a' into the input and no Approve action fires

### Requirement: aktenraum-web shows a navigation entry for the inbox with a count badge

The shared layout SHALL show a navigation entry "Inbox" with a numeric count badge equal to the `total` returned by `GET /api/inbox/?page_size=1`. The link SHALL be visible on the home page and the ask page, in addition to the inbox routes themselves.

#### Scenario: Inbox count badge updates after approving a doc

- **WHEN** the user approves a pending document
- **THEN** the inbox-list query is invalidated and the nav badge re-renders with the decremented count
