## Why

aktenraum's auth module today exposes `POST /auth/login`, `POST /auth/logout`, and `GET /auth/me` — nothing else. The user table is seeded once from `BOOTSTRAP_USERNAME` + `BOOTSTRAP_PASSWORD` env vars on first startup; after that the env vars are ignored. The result: the maintainer is stuck with whatever password the bootstrap minted, and the only ways to change it are (a) UPDATE the `password_hash` column via psql or (b) DELETE the user, edit the env file, and recreate the container. Both are terminal-only operations that demand the maintainer drop into the host shell and remember how to compute a bcrypt hash.

This is a basic affordance that any auth-bearing app needs. The reason it doesn't exist yet is that the build focus until now has been the AI / inbox / RAG path, not account management. With the testing phase live and the maintainer using the product daily, it's time to fix it.

This is also relevant for the Tailscale topology shipped in [ADR-005](../../../docs/adr/005-test-phase-access-via-tailscale.md): the maintainer is now logging in from mobile / second laptop, and "go back to the host machine to edit an env file" is even more painful than before.

## What Changes

- **New endpoint `POST /api/auth/change-password`** in `services/aktenraum-api/src/aktenraum_api/auth/router.py`. Auth-gated (requires a valid session cookie). Accepts `{current_password, new_password}`. Verifies `current_password` against the user's `password_hash`; on success, replaces the hash and clears the session cookie (forces re-login on this device and invalidates any other live session for the same user).
- **New schema** `ChangePasswordRequest` in `services/aktenraum-api/src/aktenraum_api/auth/schemas.py` with Pydantic field constraints: `current_password` 1..128 chars, `new_password` 8..128 chars. The 8-char floor is a deliberately modest minimum — bcrypt's cost factor handles brute-force resistance; complexity rules (uppercase / digits / symbols) hurt usability more than they help and aren't included.
- **Server-side validations**:
  - 401 if `current_password` doesn't verify against the stored hash.
  - 400 if `new_password == current_password` (no-op rejected so the user doesn't think they've changed anything when they haven't).
  - 422 (Pydantic) if the request body is malformed or fields violate length bounds.
- **SPA: new "Konto" section on `/settings`**. Three inputs (current password, new password, confirm new password), one submit. Confirm-mismatch is caught client-side before hitting the API. Success flow: show a green "Passwort geändert — bitte erneut anmelden" banner, then redirect to `/login` after a 1.5s grace so the user can read the message.
- **`apps/web/src/lib/api.ts` + `apps/web/src/lib/auth.ts`**: add `changePassword(current, new)` and a `useChangePassword()` mutation that invalidates `ME_KEY` on success so the auth state flips immediately.
- **Tests**: extend `services/aktenraum-api/tests/test_auth_flow.py` with happy-path + the three failure modes (wrong current password, same-as-current, unauthenticated). Verify the success path clears the cookie (the existing `Max-Age=0` assertion shape works).
- **Documentation**: CLAUDE.md gets a small row update in "What's implemented vs planned" reflecting that account password change now ships in the UI.

### Out of scope (intentionally — defer to future changes)

- **Username change** — not needed in v1 (the single-user product is fine with one username; if the maintainer hates "admin" they can rename via psql once).
- **Account creation / multi-user UI** — separate change. The `users` table supports multiple rows; the UI just doesn't surface that yet.
- **Password-reset-via-email flow** — there's no SMTP integration. If the user forgets their password, the existing "edit the bcrypt hash via psql" path is the recovery story; the v1 change-password feature is for proactive rotation, not lost-password recovery.
- **Account lockout after N failed change-password attempts** — bcrypt's cost factor (≥10 rounds) makes brute-force impractical at the speeds a real attacker can sustain; adding lockout introduces self-DoS risk for no measurable security gain in a single-user product.
- **Audit log of password changes** — no structured event log exists yet for any user action; introducing one for this single event would build the wrong abstraction. Log at `INFO` level for now; revisit if the product grows a real audit trail.

## Capabilities

### New Capabilities
None. This extends existing `aktenraum-api` auth behaviour with a new endpoint; not a separate capability domain.

### Modified Capabilities
- `aktenraum-api`: auth gains a `POST /auth/change-password` endpoint and the side-effect of session invalidation on successful change.

## Impact

- **Code (backend)**:
  - `services/aktenraum-api/src/aktenraum_api/auth/schemas.py` — add `ChangePasswordRequest`.
  - `services/aktenraum-api/src/aktenraum_api/auth/router.py` — add the route handler.
  - `services/aktenraum-api/tests/test_auth_flow.py` — extend coverage.
- **Code (SPA)**:
  - `apps/web/src/lib/api.ts` — `changePassword` helper.
  - `apps/web/src/lib/auth.ts` — `useChangePassword` mutation.
  - `apps/web/src/routes/Settings.tsx` — new section.
- **DB**: no schema change. Only existing `users.password_hash` column writes.
- **Docs**: CLAUDE.md (one row in implemented-vs-planned table). Session note when shipped.
- **Bootstrap behaviour unchanged**: `BOOTSTRAP_USERNAME` / `BOOTSTRAP_PASSWORD` continue to seed the first user on an empty `users` table; after that they remain ignored. The new endpoint is the only path for changing a password after first boot.
- **Security**: the change-password endpoint is auth-gated (cookie required) AND requires the current password — so a stolen cookie alone is not sufficient. Successful change clears the cookie, forcing re-login and invalidating any other live sessions for the same user.
