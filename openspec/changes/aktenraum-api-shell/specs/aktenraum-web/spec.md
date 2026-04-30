## ADDED Requirements

### Requirement: apps/web is a Vite + React + TypeScript SPA

The `apps/web/` directory SHALL contain a real Vite + React + TypeScript project (replacing the previous placeholder). The package SHALL be named `@aktenraum/web` and be a member of the existing pnpm workspace. It SHALL build cleanly via `pnpm --filter @aktenraum/web build` producing a `dist/` directory of static assets.

#### Scenario: SPA builds without error

- **WHEN** `pnpm install --frozen-lockfile && pnpm --filter @aktenraum/web build` runs in CI
- **THEN** the command completes with exit code 0 and `apps/web/dist/index.html` exists

### Requirement: SPA has a /login route and an authenticated / route

`/login` SHALL render a username + password form that posts to `/api/auth/login`. On success, the user SHALL be redirected to `/`. The `/` route SHALL be guarded — unauthenticated visitors are redirected to `/login`. When authenticated, `/` SHALL render an empty layout displaying the logged-in user's username and a logout button.

#### Scenario: Unauthenticated visit to / redirects to /login

- **WHEN** the SPA is loaded at `/` with no auth cookie
- **THEN** the user is navigated to `/login` before any document content renders

#### Scenario: Successful login lands on /

- **WHEN** the user submits valid credentials at `/login`
- **THEN** the form's submit handler calls `POST /api/auth/login`, the response sets the auth cookie, and the SPA navigates to `/` showing the username

#### Scenario: Logout returns to /login

- **WHEN** the logout button is clicked from `/`
- **THEN** the SPA calls `POST /api/auth/logout` and navigates to `/login`

### Requirement: SPA never reads the JWT from JavaScript

The SPA's auth state SHALL be derived solely from the response of `GET /api/auth/me` (200 = authenticated, 401 = not). The SPA SHALL NOT call `document.cookie` for the auth cookie or otherwise inspect the JWT.

#### Scenario: Auth state derives from /api/auth/me

- **WHEN** the auth guard mounts
- **THEN** it issues `GET /api/auth/me` via the shared axios instance and treats a 200 as authenticated and a 401 as unauthenticated; no other code path checks auth state
