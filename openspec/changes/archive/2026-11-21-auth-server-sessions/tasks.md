# Tasks

## 1. Schema and client address

- [x] 1.1 `sessions`, `auth_rate_limit_events`, `auth_audit` in `schema.ts`, `schema.sql` and the pg-mem harness (design §1, incl. the `auth-passkeys` values in both `CHECK` lists and `step_up_at`). Verify: `apply-schema.test.ts` green; on a throwaway `postgres:15` (`docker run --rm`) apply twice, and the checks, the unique `token_hash` and the `member_id` FK reject bad rows
- [x] 1.2 `app.set("trust proxy", 1)` in `main.ts` and the test harness; one line in `docs/configuration.md` next to the nginx note. Verify: route test — a request with `X-Forwarded-For: 203.0.113.7` reaches handlers with `request.ip` = that address; the e2e rehearsal (5.1) shows the browser address in the device list

## 2. Sessions replace the JWT

- [x] 2.1 `SessionService`: issue (token + hash + row + cookie, `__Host-` name on HTTPS, clears the other name), resolve (SQL expiry predicate + member join), touch (≤ 1/min, `least(now() + idle, absolute)`), `isActive`, revoke one / all of a member / all but one. `SESSION_IDLE_DAYS` (7), `SESSION_ABSOLUTE_DAYS` (30) in settings. Verify: unit/route tests — stored hash ≠ cookie value, unknown/revoked/idle-expired/absolute-expired → 401 (expiry forced via SQL `UPDATE … = now() - interval`), touch moves `idle_expires_at` but never past `absolute_expires_at`, two requests within a minute write once
- [x] 2.2 `AuthGuard` and `AuthService` on sessions: login and invite redemption create sessions (`auth_method` `password` / `invite`); principal gets `sessionId` + `authTime`; `jwt.ts`, `passwordFingerprint`, `jsonwebtoken`, `JWT_SECRET`, `JWT_EXPIRES_SECONDS` removed (settings, harness, `.env.example`, `bootstrap-secrets.sh`, `docs/configuration.md`). Verify: full api suite green with the harness no longer setting `JWT_SECRET`; a route test sends a JWT-shaped cookie → 401; cookie flags asserted for `COOKIE_SECURE` true (`__Host-`, `Secure`) and false
- [x] 2.3 Revocation paths (design §4): logout (server-side, unguarded, no-op for unknown cookies), change-password (all of the member's sessions), member removal lockout (all, `member_removed`). Verify: route tests — logout then replay of the old cookie → 401; password change with two agents → both 401; removal → every session row of the member revoked (extend `member-removal.routes.test.ts`)

## 3. Device list and streams

- [x] 3.1 `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`, `POST /api/auth/sessions/revoke-others` (`@RequireScope()`, own sessions only, 404 otherwise; route inventory updated); documented in `docs/api-reference.md`. Verify: route tests — two agents of one member list two sessions with one `current`; revoking the other → its next request 401, the current stays; another member's id → 404 and still active; revoking the current clears the cookie; `revoke-others` answers `{revoked: n}`
- [x] 3.2 `EventsController` re-checks `isActive(sessionId)` per tick and ends with `session_ended` (`revoked` / `expired`); the removal-only check goes. Verify: route tests — open stream + revoke from a second agent → stream ends with `event: session_ended`; same for forced expiry; the existing member-removal stream test still passes

## 4. Login protection and audit

- [x] 4.1 `AuthRateLimiter` in Postgres (design §6) replaces `LoginThrottle` for login (username + address keys) and invites (address key). Verify: route tests — 10 failures for one username → 429 + `Retry-After` even with the right password; 10 failures for different usernames from one `X-Forwarded-For` address → 429 for that address, a second address with a clean username still logs in; success resets the username key only; a new Nest app on the same pg-mem database (or the e2e restart in 5.1) still answers 429
- [x] 4.2 `AuthAuditService` + events from login (succeeded / failed with attempted username / throttled), logout, revocations (actor + reason), password change, invite redemption. Verify: route tests assert one row per event with member, session, address and user agent; no column ever contains the cookie token or its hash (scan every row of the test DB for both)
- [x] 4.3 `AuthSweepService` (startup + hourly): prune sessions revoked/expired > 30 days, rate-limit events > 1 day, audit rows > 180 days. Verify: test with back-dated rows (SQL `now() - interval`) — only the old ones go

## 5. Web, rehearsal, docs

- [x] 5.1 `useSessions` / `useRevokeSession` / `useRevokeOtherSessions` (key `["auth", "sessions"]`, invalidate on success; revoking the current one sets `ME_KEY` to null) and `components/settings/Geraete.vue` in `/settings → Konto`: list with "dieses Gerät", device label, address, times, "Abmelden" per row, "Alle anderen Geräte abmelden". Pure `deviceLabel(userAgent)` helper. Verify: unit tests for the helper (Chrome/Edge/Firefox/Safari × Windows/macOS/iOS/Android/Linux, unknown); `mountSuspended` tests — current marker, the right DELETE / POST, list refresh, current-session revoke logs out
- [x] 5.2 Full suite green: `pnpm -r lint`, `pnpm -r build`, api + web typecheck, `pnpm -r test`
- [x] 5.3 e2e rehearsal on the throwaway stack (`scripts/spikes/session-rehearsal.mjs`): login on two agents → device list shows both with distinct addresses → revoke other → 401; logout replay → 401; password change → both 401; open live stream + revoke → `session_ended`; 11 failed logins → 429, `docker compose restart aktenraum-api` → still 429; an old JWT cookie → 401. Plus worker e2e `bash scripts/e2e-worker.sh`
- [x] 5.4 ADR-010 "as built" note for this half (tables, cookie names, lifetimes, revocation reasons, rate-limit keys, `trust proxy`, rollback), CLAUDE.md (replace the "Sessions are bound to the password" gotcha, auth notes, test counts, OpenSpec status), upgrade runbook step "everyone logs in once", session note. Verify: the docs name the three tables, the new routes and the rollback step

## Workflow follow-up

- Live deploy via `docs/runbooks/upgrade-existing-install.md` (tables created at startup; every device logs in once).
- `/opsx:archive auth-server-sessions`.
- Then propose `auth-passkeys` (passkeys, recovery codes, setup link, password retirement, invite → passkey, step-up) on top of these tables.
