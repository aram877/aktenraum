# Design

## Context

- `auth-server-sessions` (live 2026-11-21) gives opaque server-side sessions (`sessions`), `SessionService`, `AuthRateLimiter` (Postgres, keys `login:user:*`, `login:ip:*`, `invite:ip:*`, 10 / 15 min), `AuthAuditService` (`auth_audit`), `AuthSweepService`, `trust proxy` = 1. `sessions.auth_method` already allows `passkey` / `recovery` / `setup`; `sessions.step_up_at` exists and is unused.
- `sessions.revoked_reason` allows only `logout`, `user`, `other_device`, `password_change`, `member_removed`; the `auth_audit.event` CHECK is fixed too. `applySchema` only runs `CREATE TABLE IF NOT EXISTS`, and `apply-schema.test.ts` forbids `DROP`, so neither list can grow.
- `users.password_hash` is `NOT NULL`. Invite redemption (`household.service.ts redeem`) creates user + member + personal space + Paperless user in one call and then issues a session.
- The WebAuthn spike (`scripts/spikes/webauthn/`, `@simplewebauthn/server` 13) verified registration, discoverable login and PRF on `http://localhost` in Chrome and WebView2; IP addresses are refused by browsers.
- Route authorization is `authorize()` in `auth/principal.ts`: `@RequireScope(...)` (empty = any authenticated principal) + `@DocumentAccess`. `test/route-inventory.test.ts` fails for a route without a scope declaration.
- pg-mem has no `least()`, timestamp subtraction or `extract(epoch …)`; expiry comparisons stay in SQL (`now() - interval …`).
- The live install is reached on `http://localhost:8080` (`COOKIE_SECURE=false`); Tailscale is not set up on the host yet.

## Goals / Non-Goals

**Goals:**
- Deny by default: a restricted session reaches only routes explicitly allowed for enrolment.
- No secret stored in a usable form: challenges single-use and short-lived; recovery codes, setup tokens stored as SHA-256; no credential material in either audit table.
- A code rollback leaves every pre-existing password member able to log in.
- Every ceremony exercisable in tests and on the e2e stack without a browser (software authenticator).

**Non-Goals:**
- Attestation verification or an authenticator allowlist (attestation `none`, as decided in ADR-010).
- Resident-key management on the authenticator (we can't delete a passkey from the device; removing it here only makes it useless).

## Decisions

### 1. Tables

```
webauthn_users(member_id PK → members.id, user_handle varchar(86) UNIQUE NOT NULL, created_at)
  -- random 64-byte WebAuthn user.id per member (base64url), never the member id or name

passkeys(
  id serial PK, member_id → members.id NOT NULL,
  credential_id varchar(1366) UNIQUE NOT NULL,      -- base64url
  public_key text NOT NULL,                          -- base64url COSE key
  sign_count bigint NOT NULL DEFAULT 0,
  transports varchar(128) NULL,                      -- comma list
  aaguid varchar(36) NULL, device_type varchar(16) NOT NULL CHECK IN ('singleDevice','multiDevice'),
  backed_up boolean NOT NULL, prf_enabled boolean NOT NULL DEFAULT false,
  rp_id varchar(253) NOT NULL, name varchar(64) NOT NULL,
  created_at, last_used_at NULL, removed_at NULL
)  INDEX (member_id)

webauthn_challenges(
  id bigserial PK, ceremony varchar(43) UNIQUE NOT NULL,   -- handle returned to the client
  challenge varchar(128) NOT NULL, kind varchar(16) NOT NULL,  -- 'register' | 'login' | 'step_up'
  purpose varchar(16) NOT NULL,      -- 'enrol' | 'add' | 'invite' | 'setup' | 'login' | 'step_up'
  member_id int NULL, session_id bigint NULL, invite_id int NULL, setup_token_id int NULL,
  username varchar(64) NULL, user_handle varchar(86) NULL,
  rp_id varchar(253) NOT NULL, origin varchar(255) NOT NULL,
  created_at, expires_at NOT NULL, used_at NULL
)

recovery_codes(id serial PK, member_id → members.id, batch_id varchar(32) NOT NULL,
  code_hash varchar(64) UNIQUE NOT NULL, created_at, used_at NULL, invalidated_at NULL)  INDEX (member_id)

setup_tokens(id serial PK, token_hash varchar(64) UNIQUE NOT NULL, member_id → members.id,
  created_by_member_id int NULL,          -- NULL = host CLI / first run
  created_at, expires_at NOT NULL, used_at NULL, revoked_at NULL)

password_retirements(member_id PK → members.id, retired_at NOT NULL DEFAULT now(), session_id bigint NULL)

credential_audit(id bigserial PK, at, event varchar(32) NOT NULL, member_id int NULL,
  actor_member_id int NULL, session_id bigint NULL, passkey_id int NULL,
  detail varchar(128) NULL, ip varchar(64) NULL, user_agent varchar(512) NULL)  INDEX (at)
```

`credential_audit.event` deliberately has **no CHECK** (events are a TypeScript union): the same "can't widen later" constraint that forces this table into existence would otherwise bite again with TOTP or tokens. Events: `passkey_added`, `passkey_renamed`, `passkey_removed`, `recovery_codes_generated`, `recovery_code_used`, `setup_link_created`, `setup_link_used`, `password_retired`, `step_up_succeeded`, `step_up_failed`. No foreign keys (outlives what it mentions). Passkey and recovery **logins** stay in `auth_audit` (`login_succeeded` / `login_failed` with `reason` = `passkey` / `recovery`).
*Alternative*: `ALTER TABLE auth_audit DROP CONSTRAINT …` in `schema.sql`. Rejected: breaks the "schema.sql never drops" rule and its test.

### 2. Ceremonies: begin / finish with a single-use challenge row

Every WebAuthn flow is two calls. `…/begin` checks the origin (§3), the rate limit and the flow's preconditions, generates options with `@simplewebauthn/server` (`userVerification: "required"`, `residentKey: "required"`, attestation `none`, `extensions: { prf: {} }` at registration, `excludeCredentials` = the member's passkeys on that RP ID), stores a `webauthn_challenges` row (5 minutes) and returns `{ ceremony, options }`. `…/finish` receives `{ ceremony, response }`, claims the row atomically (`UPDATE … SET used_at = now() WHERE ceremony = $1 AND used_at IS NULL AND expires_at > now() RETURNING *`), then verifies with `expectedChallenge`, `expectedOrigin` = the row's origin, `expectedRPID` = the row's RP ID, `requireUserVerification: true`. A claimed row is spent even when verification fails, so a response can't be retried or replayed.

Flows (`purpose`): `login` (no member; discoverable), `step_up` (member + session; `allowCredentials` = the member's passkeys on that RP ID), `enrol` (restricted session's first passkey), `add` (full session, step-up), `invite` (invite id + chosen username + fresh user handle), `setup` (setup token id).

Authentication finish looks up `passkeys` by credential id (`removed_at IS NULL`, member not removed), checks `response.userHandle` equals the member's user handle, updates `sign_count` (a regression on a non-zero counter is refused and logged — synced passkeys report 0) and `last_used_at`.
*Alternative*: keep the challenge in a signed cookie. Rejected: needs a signing key again, and the atomic "claim" is what gives replay safety.

### 3. Origins and RP IDs

`WEBAUTHN_ORIGINS` (default `http://localhost:8080,http://localhost:4300`) and `WEBAUTHN_RP_IDS` (default `localhost`), comma lists, validated at startup (every origin's hostname must be one of the RP IDs; IP literals rejected). A ceremony's origin is the request's `Origin` header; not in the list → 400 before a challenge is created. RP ID = the origin's hostname. `GET /api/auth/webauthn` (public) returns `{ origins }`, and the login page compares `window.location.origin` to show the "Passkeys funktionieren hier nicht — nutze …" hint.
*Alternative*: derive the RP ID from `Host` / `X-Forwarded-Host`. Rejected: a header-derived RP ID is exactly what the allowlist exists to prevent.

### 4. Restricted sessions, deny by default

The principal gains `authMethod` and `restricted`. A session is **restricted** when its `auth_method` is `password` or `recovery`, or its member has no active passkey (one `EXISTS` in `SessionService.resolve`, no extra round trip). Restricted principals get only the new scope `auth:enrol`, and `authorize()` refuses any route not marked `@AllowRestricted()` with 403 `{detail: "enrolment_required"}` — checked before scopes, so a forgotten marker fails closed. Allowed: `GET /auth/me` (adds `enrolment_required: true`), `POST /auth/passkeys/register/begin|finish` (purpose `enrol`), `GET /auth/webauthn`; logout is unguarded already. The live-counts stream is not allowed (the SPA doesn't open it while `me` says enrolment is required).

Finishing an `enrol` ceremony in one transaction-like sequence: store passkey → generate recovery codes (if the member has no unused codes) → `password_retirements` row (if absent) → revoke every `password` session of the member including the current one (`revoked_reason = 'password_change'`) and the current recovery session (`'user'`) → issue a fresh `passkey` session with `step_up_at = now()` → answer `{ recovery_codes? }`. A fresh session (not an upgraded one) avoids session fixation.
*Alternative*: per-route scope checks only. Rejected: `@RequireScope()` (empty) means "any authenticated principal" on a dozen routes; one missing scope would open them to a recovery session.

### 5. Passwords retire, hashes stay

`AuthService.authenticate` refuses (like a wrong password, after the bcrypt compare, counted by the limiter) when the member has a `password_retirements` row. The hash is kept so a code rollback restores every pre-existing password login; wiping hashes is a later cleanup once passkeys are proven. Members created without a password (invite, first run via setup link) get `password_hash = '!'` (not a bcrypt string; `verifyPassword` returns false for non-bcrypt input instead of throwing) and a retirement row. `POST /auth/change-password` and the Konto password form are removed. `BOOTSTRAP_PASSWORD` keeps working when set (existing installs, the e2e stack) and yields a password member who must enrol; `first-run.sh` stops generating it.

### 6. Recovery codes

16 Crockford-base32 characters (80 bits), shown as `XXXX-XXXX-XXXX-XXXX`; input is normalised (upper-case, drop spaces / dashes, `O→0`, `I/L→1`). Stored as SHA-256 hex (80 bits makes an offline search over a DB dump impractical without a pepper). Ten per batch; a new batch sets `invalidated_at` on the old unused ones. `POST /auth/recovery` `{username, code}`: rate-limit keys `login:user:<name>` + `login:ip:<addr>`, claim atomically (`UPDATE … SET used_at = now() WHERE member_id = … AND code_hash = … AND used_at IS NULL AND invalidated_at IS NULL RETURNING id`), always pay the same work for unknown usernames, issue a `recovery` session (restricted). `GET /auth/recovery-codes` → `{remaining}`; `POST /auth/recovery-codes` (step-up) → new batch, shown once.

### 7. Setup links and the host CLI

Same shape as invites: 32 random bytes base64url, `/setup/<token>`, SHA-256 stored, 30 minutes, uniform 404 for every invalid state, `setup:ip:<addr>` limit. `GET /api/setup/:token` → `{username, expires_at}`; `POST /api/setup/:token/register/begin|finish` → passkey, new recovery batch (old invalidated), retirement row, full `setup` session with `step_up_at = now()`. Issuers: `POST /api/household/members/:id/setup-link` (household admin, step-up, any non-removed member incl. themselves; revokes that member's earlier unused links), and `node dist/auth/setup-link-cli.js <username>` inside the api container (direct DB, prints `<first WEBAUTHN_ORIGINS entry>/setup/<token>`), wrapped by `scripts/setup-link.sh` / `task setup-link USER=…`. `first-run.sh` calls it for the bootstrap admin (created passwordless when `BOOTSTRAP_PASSWORD` is empty) and prints the link instead of a password. Using a link does not revoke other sessions; the success page offers "Andere Geräte abmelden" (device list) — `revoked_reason` has no fitting value, and the member decides.

### 8. Invites enrol a passkey

`POST /api/invites/:token/register/begin` `{username}` validates like today (pattern, free — 409), checks the invite is pending (uniform 404, counted), creates a user handle and a challenge (`purpose = invite`); `…/finish` verifies, then runs the existing `HouseholdService.redeem` path with a passwordless user, stores the passkey and recovery codes, and issues an `invite` session (`step_up_at = now()`). A cancelled or failed ceremony leaves the invite pending (it is only claimed in finish).

### 9. Step-up

`@RequireStepUp()` metadata, checked in `authorize()` after scopes for member principals: `SessionService.stepUpFresh(sessionId)` (`step_up_at > now() - interval '5 minutes'`) or 403 `{detail: "step_up_required"}`. `POST /api/auth/step-up/begin|finish` (any full session): assertion must resolve to a passkey of the caller → `UPDATE sessions SET step_up_at = now()`; failures count on `login:ip:<addr>` and are audited. Passkey, setup and invite logins set `step_up_at` at creation. Marked routes: `POST /trash/empty`, `POST /trash/:doc_id/delete`, passkey add / rename / delete, `POST /auth/recovery-codes`, `POST|DELETE /household/invites*`, `POST /household/members/:id/setup-link`, `POST /household/members/:id/remove`, `DELETE /spaces/:id`, `POST|PATCH|DELETE /spaces/:id/members*`, `PATCH /settings/llm`, `PATCH /settings/answer-llm`, `PUT /settings/auto-approve`. A route-inventory test pins the list.

SPA: `useApi` catches 403 `step_up_required`, runs `startAuthentication` (`@simplewebauthn/browser`) through the step-up endpoints, and retries the original request once; a cancelled dialog surfaces "Bestätigung abgebrochen". 403 `enrolment_required` sends the router to `/enrol`.

### 10. Passkey management and display

`GET /api/auth/passkeys` → `[{id, name, provider, synced, rp_id, created_at, last_used_at, prf}]`; `PATCH /api/auth/passkeys/:id` `{name}`; `DELETE /api/auth/passkeys/:id` (409 when it is the last active one; 404 for others' or unknown); `POST /api/auth/passkeys/register/begin|finish` with `purpose = add` (step-up) or `enrol` (restricted). Default name: provider + date. Provider from a static AAGUID map (`auth/aaguids.ts`: Google Password Manager, Windows Hello (3 AAGUIDs), iCloud Keychain, 1Password, Bitwarden, Chrome on Mac, Samsung Pass; verified against the community `passkey-authenticator-aaguids` list at implementation); unknown → "Passkey". `synced` = `device_type = 'multiDevice'`.

### 11. Limits, audit, sweep

New limiter keys `setup:ip:<addr>`; passkey and step-up failures reuse `login:ip:<addr>`; recovery uses `login:user` + `login:ip`. `CredentialAuditService` mirrors `AuthAuditService` (best effort). `AuthSweepService` additionally deletes challenges expired > 1 day, setup tokens expired/used > 30 days, invalidated or used recovery codes > 180 days, credential audit > 180 days.

### 12. Testing without a browser

`src/test/soft-authenticator.ts`: a P-256 key pair per credential, builds `attestationObject` (fmt `none`) and assertions (authenticatorData with UP + UV flags, counter, signature over `authData || sha256(clientDataJSON)`) using `isoCBOR` from `@simplewebauthn/server/helpers`. Route tests drive every flow with it; `scripts/spikes/passkey-rehearsal.mjs` reuses the same logic against the e2e stack. One manual browser check on the live install (Chrome, Windows Hello / Google Password Manager) after deploy.

## Risks / Trade-offs

- [A member enrols only a device-bound passkey and loses the PC] → recovery codes are mandatory and shown with the first passkey; the Konto page nags when only one passkey exists; admin setup link and host CLI as last resorts.
- [Passkeys bound to `localhost` don't work over Tailscale later] → documented; the device list shows each passkey's address; adding a second passkey from the new address needs only a signed-in session there (recovery code or setup link if none).
- [Restricted-session logic is new attack surface] → deny-by-default marker, a route-inventory test listing exactly the allowed routes, tests that every other route answers 403 for password and recovery sessions.
- [Rolling back strands passkey-only members] → runbook: before a rollback, set a temporary password for them (`UPDATE users SET password_hash = <bcrypt>` with a one-liner in the old image); pre-existing password members keep working automatically.
- [Static AAGUID map goes stale] → unknown providers show "Passkey"; display only, no security decision depends on it.
- [Challenge rows can be created by anonymous `login/begin` calls] → 5-minute expiry, hourly sweep, and begin is refused for a throttled address.
- [The live household can lock itself out during the switch] → the password works until a passkey is enrolled; the setup-link CLI is deployed with the change and rehearsed on the e2e stack before the live deploy.

## Migration Plan

- Deploy: `applySchema` creates the seven tables. Existing sessions stay valid but become restricted (they are `password` sessions), so every member is sent to `/enrol` on their next request: create a passkey, note the recovery codes, continue. No forced re-login.
- Rehearse on the e2e stack (`passkey-rehearsal.mjs`): password member → restricted → enrol → password refused; passkey login; step-up on empty trash; recovery-code login → restricted → enrol; admin setup link; CLI setup link; invite with passkey; rate limits; then the worker e2e.
- Live: deploy per the upgrade runbook, then the maintainer enrols in Chrome on `localhost` and keeps the recovery codes; `task setup-link USER=<name>` is the fallback if enrolment fails.
- Rollback: revert the code. Password members log in with their password as before; passkey-only members need a temporary password first (see Risks). The new tables stay unused.

## Open Questions

- Whether to wipe `users.password_hash` (and drop the rollback path) after a few weeks of passkey-only use — a follow-up, not part of this change.
- Which AAGUIDs to add once Safari / iCloud passkeys have been tried on a Mac.
