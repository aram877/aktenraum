# Design

## Context

- **Principal and policy** (ADR-010 steps 1–2): `AuthGuard` reads the session cookie, `SessionService.resolve` checks it in one SQL query, `TenancyService.resolveMember` drops removed members, and `authorize()` then checks the route's `@RequireScope`, `@AllowRestricted`, `@RequireStepUp` and `@DocumentAccess` (policy → 404). `MemberPrincipal` carries `sessionId`, `authMethod`, `restricted`, `stepUpFresh`, `clientId: "spa"`.
- **Routes with an empty `@RequireScope()`** (any authenticated principal) are exactly the credential routes: `/auth/me`, sessions, passkeys, step-up, recovery codes. Step-up routes are pinned in `test/route-inventory.test.ts`.
- **Bearer today** (`service-credentials`): `bearerValue` in `@aktenraum/core` parses `Bearer <value>` strictly. `UserOrInternalGuard` sends any `Authorization` header to the worker check; `AuthGuard` ignores the header.
- **Persistence helpers already in place**: `AuthRateLimiter` (Postgres, 10 / 15 min), `CredentialAuditService`, `AuthSweepService` (hourly), `MemberRemovalService.remove` (revokes sessions as its lockout step).
- **SPA**: `/settings → Konto` already hosts `Passkeys.vue`, `Wiederherstellung.vue` and `Geraete.vue`. `useApi` runs the step-up dialog on `403 step_up_required` and repeats the request.

See proposal.md for motivation and specs/auth-personal-access-tokens for the requirements.

## Goals / Non-Goals

**Goals:**
- One more way to sign in, resolved into the same `MemberPrincipal`, so scopes, policy, share audit and the route inventory apply unchanged.
- A token can't do anything a member's browser session protects with a passkey: deny by default for credential routes and step-up routes, so that a future sensitive route is closed to tokens automatically.
- Fast and cheap per request: one indexed lookup, and the usage write throttled.

**Non-Goals:**
- A generic OAuth token table. Phase 3 will bring its own (`oidc-provider` storage); PATs stay a small, separate table.
- Caching token lookups in memory. Revocation has to take effect on the next request, and the indexed lookup is cheap.

## Decisions

### D1. Format `akt_pat_<43 chars base64url>`, unpeppered SHA-256
32 random bytes (`crypto.randomBytes`), base64url, prefixed. The database stores `sha256(value)` as hex in a unique column, plus `display_prefix` = the first 12 characters (`akt_pat_` + 4) for the list. With 256 bits of entropy an offline search is infeasible, so there's no pepper and no bcrypt (the same reasoning as the session token and the recovery codes).
*Alternative*: a separate id part plus a secret (`akt_pat_<id>_<secret>`) to look the row up by id and compare the hash in constant time. Rejected: the unique hash index already finds the row in one lookup, and a hash lookup leaks nothing usable about the value.

### D2. Table `personal_access_tokens`
`id serial`, `member_id`, `household_id`, `name varchar(64)`, `token_hash varchar(64) unique`, `display_prefix varchar(16)`, `scopes varchar(256)` (comma list, validated against the token-scope enum on write and on read), `created_at`, `expires_at NOT NULL`, `last_used_at`, `last_used_ip varchar(64)`, `revoked_at`, `revoked_reason varchar(32)` (`user` / `member_removed`), `revoked_by_member_id`. It's added to both `schema.ts` and `schema.sql` (`apply-schema.test.ts`). A comma list rather than an array or jsonb, because pg-mem handles arrays poorly; the column is small and closed.
"Active" is decided in SQL: `revoked_at IS NULL AND expires_at > now()` (database clock, as for sessions). Expiry is `now() + make_interval(days => $n)`, computed in SQL; pg-mem may need the `now() + ($n || ' days')::interval` form, to be checked against both.

### D3. Bearer resolution: the prefix picks the check
A shared helper `authenticateBearer(header)` in `auth/bearer.ts`:
- `akt_pat_…` → `TokenService.resolve(value, ip)`: one query (active token ⋈ member ⋈ user), then `TenancyService.resolveMember` (the removed-member filter, as for sessions). On success it builds a `MemberPrincipal` with `clientId: "pat"`, `tokenId`, `sessionId: null`, `authMethod: "token"`, `restricted: false`, `stepUpFresh: false`, `authTime: created_at`, and scopes = token scopes ∩ `memberScopes(role)`.
- `akt_svc_…` → the worker check (only in `UserOrInternalGuard` and `InternalGuard`).
- anything else, a malformed header, an unknown, expired or revoked token → 401 `Invalid token`.

`AuthGuard`: `Authorization` present → bearer only (PAT), never the cookie; absent → cookie as today. `UserOrInternalGuard`: present → `akt_svc_` is the worker, `akt_pat_` a PAT; absent → cookie. `InternalGuard`: worker only, so a PAT there is 401. The `service-credentials` rule "a header present means no cookie fallback" stays, now on all three guards.
*Alternative*: a separate `TokenGuard` on chosen routes. Rejected: it would need ~70 controller edits, and the "bearer present → no cookie" rule would have to be repeated per guard.

### D4. Deny-by-default for tokens in `authorize()`
A token principal is refused with **403 `session_required`** when the route:
1. declares an empty `@RequireScope()` (credential management), unless it carries the new `@AllowToken()` (only `GET /auth/me`); or
2. carries `@RequireStepUp()`. It's refused because tokens never have a fresh step-up, and the explicit code is clearer than `step_up_required`, which would make the SPA-style client try a passkey; or
3. carries the new `@SessionOnly()`: the live-counts SSE (its session re-check doesn't apply to tokens) and the token routes themselves (`/auth/tokens*` declare scopes-free + `@SessionOnly()` for clarity).

This check runs right after the restricted check and before scopes. `route-inventory.test.ts` gains `TOKEN_ROUTES_ALLOWED_EMPTY_SCOPE = ["GET /auth/me"]` and `SESSION_ONLY_ROUTES`, and a walk asserts that every step-up or empty-scope route answers a valid token with 403 `session_required`.
*Alternative*: an allowlist of token-usable routes. Rejected: it would mark almost every member route, and the scope check already limits tokens. The routes that matter to keep closed are the credential and step-up routes, and those are already marked.

### D5. Token scopes are a fixed subset; effective = token ∩ role
`TOKEN_SCOPES` = `MEMBER_SCOPES` minus `household:admin` and `settings:write`. Both excluded scopes guard household administration and system configuration, whose routes are mostly step-up anyway. Intersecting with the role on every request means a future role downgrade shrinks existing tokens without rewriting rows.

### D6. Usage tracking throttled to once a minute
`resolve` updates `last_used_at` / `last_used_ip` with `WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`. That is at most one write per token per minute, done fire-and-forget after the read, so a failed write never fails the request (`pat_usage_update_failed`). It mirrors the session idle-slide throttle.

### D7. Rate limiting and audit
- A failed token attempt (unknown, expired or revoked `akt_pat_` value) calls `AuthRateLimiter.recordFailure(["token:ip:<addr>"])`. Before each token lookup, `retryAfterSeconds(["token:ip:<addr>"])` → 429 + `Retry-After`. Successful use never resets it (a stolen-token prober shouldn't clear its own count). The limits are the shared 10 / 15 min.
- `credential_audit` events: `token_created`, `token_revoked` (actor = owner, or the admin for `member_removed`), `token_rejected_expired` (at most once per token per hour, so a cron job running with an expired token doesn't flood the audit). The detail field holds the display prefix and name, never the value.

### D8. Routes
- `GET /api/auth/tokens`: the caller's tokens, newest first, including expired/revoked ones from the last 30 days.
- `POST /api/auth/tokens`: `{name, scopes, expires_in_days}`, step-up, 25-active cap (409), returns `{token: {...list fields}, value}`.
- `DELETE /api/auth/tokens/:id`: own token only (another's id → 404), idempotent, no step-up (the same reasoning as revoking a session).

All three use `AuthGuard` + `@RequireScope()` + `@SessionOnly()`; the POST also carries `@RequireStepUp()`. `/auth/me` adds `auth_method: "token"` (and `token_name`) for token principals.

### D9. Revocation on member removal, cleanup in the sweep
`MemberRemovalService.remove` revokes the member's tokens (`member_removed`) in the lockout step, next to `revokeAllOfMember`. Even without that, `resolveMember` already refuses a removed member, so the revoke is defence in depth and makes the list honest. `AuthSweepService` deletes tokens revoked or expired more than 30 days ago.

### D10. SPA
`components/settings/Zugriffstokens.vue` sits under Konto, after Geräte, with a `useTokens` composable (query key `["auth", "tokens"]`, invalidated on create/revoke). The create dialog has a name, scope checkboxes with German labels (`Dokumente lesen`, `Dokumente bearbeiten`, `Dokumente löschen`, `Hochladen`, `KI-Fragen`, `Einstellungen lesen`, `Freigaben verwalten`, `Akten verwalten`) and an expiry select (30 / 90 / 365 / custom). The step-up retry runs through `useApi` unchanged. The show-once panel offers copy to clipboard and the warning "Wird nur jetzt angezeigt". Revoking asks for a two-click confirm.

## Risks / Trade-offs

- [A leaked token grants its scopes until revoked or expired] → Mandatory expiry ≤ 365 days, narrow scopes chosen per token, last-used time and address visible in the list, one-click revoke, and the runbook entry. Tokens can't change credentials or perform step-up actions, so a leak can't be escalated into account takeover.
- [Brute-forcing token values] → 256 bits make it infeasible; the per-address throttle bounds the noise and makes probing visible.
- [Behind `tailscale serve`, every tailnet device shares one client address (known limitation of sessions too)] → One misbehaving script can throttle token use for the others on the tailnet for 15 minutes. Acceptable; documented next to the existing note.
- [Bearer header now overrides the cookie on every member route] → The SPA never sends `Authorization`, so browser behaviour is unchanged. A browser extension that injects a header would get 401, which is the intended fail-closed behaviour.
- [CSRF] → A cross-site page can't attach an `Authorization` header without a CORS preflight, and aktenraum sends no CORS allowance. The `Sec-Fetch-Site` check still runs for every request.
- [`last_used_at` writes on a busy script] → Throttled to one per minute per token.

## Migration Plan

1. Deploy: `applySchema` creates `personal_access_tokens` at api start. No env change, and no Paperless or Qdrant change.
2. Rehearse on the e2e stack: create a token via a stepped-up session (`scripts/spikes/e2e-session.mjs`), upload with it, read the library, get 403 on `/trash/empty` and `/auth/tokens`, revoke it, then get 401.
3. Rollback: revert the code. The table stays unused and tokens simply stop working; nothing else depends on it.
