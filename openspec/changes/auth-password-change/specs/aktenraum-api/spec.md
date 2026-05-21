## ADDED Requirements

### Requirement: Authenticated users can rotate their own password from the SPA

The system SHALL expose a `POST /api/auth/change-password` endpoint that lets a currently-authenticated user replace their own password without any terminal, database, or env-file access. The endpoint MUST require both a valid session cookie AND the user's current password.

#### Scenario: Authenticated user supplies correct current password and a valid new password

- **WHEN** a logged-in user POSTs `{current_password: "<correct>", new_password: "<at-least-8-chars-and-differs-from-current>"}` to `/api/auth/change-password`
- **THEN** the server responds `204 No Content`
- **AND** the user's `password_hash` column is updated to a bcrypt hash of the new password
- **AND** the response clears the auth cookie (Max-Age=0 or equivalent), forcing re-login on the current device
- **AND** subsequent `GET /api/auth/me` calls return 401 until the user logs in again
- **AND** logging in again with the new password succeeds; logging in with the old password fails

#### Scenario: Current password is wrong

- **WHEN** an authenticated user POSTs `/api/auth/change-password` with an incorrect `current_password`
- **THEN** the server responds `401 Unauthorized` with an error detail indicating credential failure
- **AND** the user's `password_hash` is unchanged
- **AND** the response does NOT clear the auth cookie — the user remains logged in

#### Scenario: New password equals current password

- **WHEN** an authenticated user POSTs `/api/auth/change-password` with `new_password == current_password`
- **THEN** the server responds `400 Bad Request` with a detail indicating the new password must differ
- **AND** the user's `password_hash` is unchanged
- **AND** the response does NOT clear the auth cookie

#### Scenario: Unauthenticated request

- **WHEN** a client without a valid session cookie POSTs `/api/auth/change-password`
- **THEN** the server responds `401 Unauthorized`
- **AND** no database write occurs

#### Scenario: Pydantic field bounds enforced

- **WHEN** a client POSTs `/api/auth/change-password` with a `new_password` shorter than 8 characters OR longer than 128 characters
- **THEN** the server responds `422 Unprocessable Content` (Pydantic validation)
- **AND** the user's `password_hash` is unchanged

#### Scenario: The SPA Settings page exposes the password-change form

- **WHEN** an authenticated user opens `/settings` in the SPA
- **THEN** the page renders a "Konto" section above the existing model pickers
- **AND** the section contains three password inputs (current, new, confirm) and a single submit button
- **AND** client-side validation refuses to submit when the confirm field doesn't match the new field
- **AND** the submit button is disabled while the request is in flight

#### Scenario: SPA success path

- **WHEN** the SPA receives a `204 No Content` response from `/api/auth/change-password`
- **THEN** the page shows a German success banner indicating the password was changed
- **AND** the page redirects to `/login` within a short grace window (≤ 2 seconds) so the user can read the message
- **AND** the auth state (`/api/auth/me` query) is invalidated so the user is treated as logged out across the SPA
