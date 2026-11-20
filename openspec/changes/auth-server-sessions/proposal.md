# Proposal

## Why

A login today is a signed 8-hour JWT that the server can't take back. Logout only deletes the cookie (a copied token stays valid until it expires), there is no list of where a member is signed in, one lost device can only be shut out by changing the password (which logs out every device), and open live-counts streams never re-check who they serve (ADR-010 finding E; member removal patched only that one case). The login throttle lives in memory and resets on every restart, and nobody can see failed logins afterwards. ADR-010 step 4 fixes this with server-side sessions and passkeys. This change is its first half (maintainer decision 2026-11-20: two changes, sessions first): **revocable server-side sessions, a device list, persisted rate limits and an auth audit log**, with password login unchanged. Passkeys, recovery codes, the setup link and step-up follow in `auth-passkeys` on top of these tables.

## What Changes

- **BREAKING (one forced re-login)**: the session cookie holds an opaque 256-bit random token instead of a JWT; the database stores only its SHA-256 hash in a new `sessions` table. Every existing JWT cookie stops working once, on deploy. `JWT_SECRET` and `JWT_EXPIRES_SECONDS` are retired; the password fingerprint (`pwf`) goes away because sessions are revoked explicitly.
- **Lifetimes**: a browser session expires after **7 days without use** or **30 days after login**, whichever comes first (`SESSION_IDLE_DAYS`, `SESSION_ABSOLUTE_DAYS`). Use slides the idle expiry, written at most once a minute.
- **Cookie**: `httpOnly`, `SameSite=Lax`; on HTTPS (`COOKIE_SECURE=true`) it is `Secure` and named `__Host-aktenraum_session`; plain-HTTP localhost keeps `aktenraum_session`.
- **Revocation everywhere it is meant**:
  - logout revokes the session on the server, not only in the browser;
  - a password change revokes every session of the member (today's behaviour, now enforced server-side);
  - removing a member revokes all their sessions in the lockout step;
  - a member revokes one of their own sessions, or "all other devices".
- **Device list** in `/settings → Konto`: every active session of the member with device (browser + OS from the user agent), address, sign-in time, last use and a "dieses Gerät" marker; "Abmelden" per row and "Alle anderen Geräte abmelden".
- **Open streams follow their session**: the live-counts stream ends with `session_ended` within one poll interval of the session being revoked or expiring (generalises the member-removal check, fixes finding E).
- **Persisted rate limits**: login failures are counted per username and per client address in Postgres (survive restarts); invite redemption per client address. Same thresholds as today (10 failures / 15 min → 429 + `Retry-After`).
- **Real client addresses**: the api trusts exactly one proxy hop (nginx), so `request.ip` is the browser's address, not nginx's. Today every "per-IP" limit effectively counts all clients together.
- **Auth audit log** (`auth_audit`): login succeeded / failed / throttled, logout, session revoked (by whom and why), password changed, invite redeemed, with member (if known), session, address and user agent. 180 days retention. Stored only; no UI in this change.

## Non-goals

- Passkeys, recovery codes, the setup link, retiring passwords, invite → passkey enrolment, step-up confirmation (all `auth-passkeys`; the `sessions` table already carries `auth_method` and `step_up_at` for it, because `applySchema` can't add columns later).
- An admin view of other members' sessions, or of the audit log.
- Personal access tokens, OAuth clients, service credentials (ADR-010 steps 5–6).
- Remembering devices across logins, "trusted device" flags, geolocation of addresses.

## Capabilities

### New Capabilities
- `auth-sessions`: how a browser session is created, identified, kept alive, expired and revoked; the member's device list; what open streams do when their session ends.
- `auth-login-protection`: persisted login and invite rate limits per account and per client address, and the auth audit log.

### Modified Capabilities
<!-- none: main specs are not kept in this repo; requirements are written as ADDED -->

## Impact

- **API**:
  - New tables `sessions`, `auth_rate_limit_events`, `auth_audit` (`schema.sql`, `schema.ts`, pg-mem harness).
  - `AuthService` issues / resolves / revokes sessions instead of JWTs; `auth/jwt.ts` and the `jsonwebtoken` dependency go. `AuthGuard` resolves the session (one indexed lookup) and puts `sessionId` + `authTime` on the member principal.
  - New routes `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`, `POST /api/auth/sessions/revoke-others` (any authenticated member, own sessions only).
  - `LoginThrottle` (in memory) replaced by a Postgres-backed limiter used by login and invite redemption.
  - `app.set("trust proxy", 1)` in `main.ts`.
  - `MemberRemovalService` revokes the member's sessions; `EventsController` re-checks the session each tick.
  - A sweep (startup + hourly) prunes expired sessions, old rate-limit events and audit entries past retention.
- **Web**: `components/settings/Geraete.vue` in `/settings → Konto` (`useSessions`, `useRevokeSession`, `useRevokeOtherSessions`), a pure user-agent → "Chrome · Windows" helper.
- **Config / ops**: `docker/.env.example`, `docs/configuration.md`, `bootstrap-secrets.sh` drop `JWT_SECRET` / `JWT_EXPIRES_SECONDS` (left in existing `.env` files, simply unused); new optional `SESSION_IDLE_DAYS`, `SESSION_ABSOLUTE_DAYS`. Upgrade runbook: everyone logs in once after the deploy.
- **Worker**: none.
- **Docs**: ADR-010 "as built" note for this half, CLAUDE.md (sessions gotcha replaces "Sessions are bound to the password"), api-reference, configuration, session note.
