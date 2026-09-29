## ADDED Requirements

### Requirement: Route parity with the Angular SPA
The Nuxt app SHALL implement every route currently served by the Angular SPA using Nuxt file-based routing: `/login`, `/`, `/ask`, `/library` (archive tab and `?tab=review` review tab), `/library/[id]`, `/inbox/[id]`, `/upload`, `/trash`, `/settings`, `/health`, and a catch-all not-found page. Each page SHALL be a lazily loaded route chunk.

#### Scenario: Review tab is addressable by URL
- **WHEN** a signed-in user navigates to `/library?tab=review`
- **THEN** the Library page renders with the review tab active and lists the pending documents

#### Scenario: Unknown route shows the not-found page
- **WHEN** a user navigates to a path that matches no page
- **THEN** the catch-all page renders instead of a blank screen or an unhandled router error

### Requirement: Client-side rendering only
The Nuxt app SHALL run with `ssr: false` and SHALL be built as static files (`nuxt generate`) that nginx serves with no Node runtime at deploy time.

#### Scenario: Built output is static
- **WHEN** `pnpm --filter <nuxt package> build` completes
- **THEN** the output directory contains `index.html` and hashed JS/CSS assets and no server bundle is required to serve the app

### Requirement: Authentication route middleware
Protected pages SHALL be guarded by an `auth` route middleware that calls `GET /api/auth/me` and redirects to `/login` on HTTP 401. `/login` SHALL be guarded by a `guest` middleware that redirects signed-in users to `/`. `/health` SHALL be reachable without authentication. The auth token SHALL stay in the httpOnly cookie and SHALL never be read by client code.

#### Scenario: Unauthenticated visit to a protected page
- **WHEN** a visitor without a valid session cookie opens `/library`
- **THEN** they are redirected to `/login` and the navigation bar is not rendered

#### Scenario: Signed-in visit to the login page
- **WHEN** a signed-in user opens `/login`
- **THEN** they are redirected to `/`

### Requirement: Data-fetching parity
The data layer SHALL use `@tanstack/vue-query` with the same query keys, `staleTime` values, default options (`staleTime` 30s, `retry` 1, no refetch on window focus) and invalidation rules as the Angular app. At minimum: approving or rejecting a document invalidates `["inbox"]` and `["library"]`, trash actions invalidate the trash key and `["library"]`, and login/logout invalidate the `me` key.

#### Scenario: Approve invalidates both lists
- **WHEN** a document is approved from the review tab or the inbox detail page
- **THEN** the inbox and library query caches are both invalidated, so the document leaves review and shows up in the library on the next render

#### Scenario: Reactive query key follows the URL
- **WHEN** a Library filter changes the URL query string
- **THEN** the library query key changes with it and a new request is issued, with no manual refetch call

### Requirement: API error shape handling
All HTTP calls SHALL go to same-origin `/api/*` with credentials included. Error messages shown to the user SHALL come from the API's `{detail}` body (string, or the first `msg` of a validation array), fall back to "Server nicht erreichbar." on network failure, and fall back to the status line otherwise.

#### Scenario: Validation error surfaces the detail message
- **WHEN** the API responds 422 with `{"detail": [{"msg": "Passwort zu kurz"}]}`
- **THEN** the UI shows "Passwort zu kurz"

### Requirement: Streaming answer consumption
The Ask page SHALL consume `POST /api/ai/answer/stream` as a streamed response. It SHALL render `chunk` text as it arrives and resolve citation cards from the `final` event, and SHALL show an `error` event as an error state.

#### Scenario: Answer renders incrementally
- **WHEN** a question is submitted on the Ask page
- **THEN** answer text appears progressively as `chunk` events arrive, not all at once after the answer completes

### Requirement: Live counts stream
While a user is signed in, the app SHALL subscribe once to `GET /api/events/counts` (EventSource), write each event into the query cache under the live-counts key, reconnect after a 5-second back-off when the connection errors, and close the stream on logout. The navigation bar SHALL read review, in-flight and trash badge counts from that cache entry.

#### Scenario: Server drops the stream
- **WHEN** the EventSource connection errors
- **THEN** the client closes it and opens a new connection after 5 seconds, not in a tight retry loop

#### Scenario: Stream is not opened for guests
- **WHEN** the login page renders for an unauthenticated visitor
- **THEN** no connection to `/api/events/counts` is opened

### Requirement: Keyboard shortcuts on review pages
The inbox detail page SHALL bind `a` (approve), `r` (reject), `j`/`k` (next/previous), and `Esc` (back to `/library?tab=review`). Shortcuts SHALL be ignored while focus is in an input, textarea, select or contenteditable element, or while Meta/Ctrl/Alt is held. Listeners SHALL be removed when the page unmounts.

#### Scenario: Typing in a field does not trigger approve
- **WHEN** the user types the letter "a" into an editable AI field
- **THEN** the document is not approved

### Requirement: Upload with per-file progress
The Upload page SHALL accept drag-and-drop and file-picker input for one or many files, post them to `/api/documents/upload`, then poll task status and document lifecycle status per file with the same intervals and ceiling as the Angular app, showing each file's state independently.

#### Scenario: One failing file does not block the others
- **WHEN** three files are uploaded and the second is rejected
- **THEN** the first and third continue through to "in der Inbox" / "in der Bibliothek" while the second shows an error

### Requirement: Responsive layout parity
The app SHALL keep the Angular app's Tailwind breakpoints and behavior: the nav collapses to a drawer below `md`, list views switch from table to cards below `md`, and two-pane detail views switch to a PDF/Bearbeiten tab toggle below `lg`.

#### Scenario: Library list becomes cards on mobile
- **WHEN** the viewport is narrower than the `md` breakpoint
- **THEN** the library list renders one card per document instead of a table

### Requirement: Compatible with the existing CSP
The built app SHALL run under the nginx Content-Security-Policy unchanged, in particular `script-src 'self'`, with no CSP violations logged in the browser console on any route.

#### Scenario: No inline-script violation on load
- **WHEN** the Nuxt build is served by the nginx image and `/` is opened
- **THEN** the browser console shows no Content-Security-Policy violation

### Requirement: Test and lint coverage
The Nuxt package SHALL provide `test` and `lint` scripts that run under `pnpm -r test` / `pnpm -r lint` and in CI. It SHALL include a Vue test for each behavior covered by an existing Angular spec (login, auth middleware, nav, library, review tab, inbox review, ask stream parsing, upload, konto, auto-approve, health).

#### Scenario: Workspace test run includes the Nuxt app
- **WHEN** `pnpm -r test` runs at the repository root
- **THEN** the Nuxt package's test suite runs and must pass for the command to succeed
