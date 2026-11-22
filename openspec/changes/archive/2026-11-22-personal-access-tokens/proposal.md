# Proposal

## Why

The only way to use aktenraum's API today is a browser session, which takes a passkey ceremony to get. A script that uploads scanner output, a backup job that exports documents, or a home-automation hook that asks "is the electricity bill due?" either can't authenticate at all or would need a copied session cookie: that cookie grants every scope the member has, can manage passkeys and devices, and dies after 7 idle days. ADR-010 §6 decided that scripts and integrations get **personal access tokens** (phase 2), and with service credentials (step 5) in place, a bearer token is the last missing way to sign in. This change is ADR-010 step 6. OAuth and the device flow (phase 3) stay deferred until a concrete client needs them.

## What Changes

- **Personal access tokens (PATs)**: a member creates a named token in `/settings → Konto → Zugriffstokens`. The value is `akt_pat_` + 43 base64url characters (32 random bytes). It's shown exactly once; the server stores only its SHA-256 hash.
- **Scoped**: at creation the member picks a subset of the token scopes: `documents:read`, `documents:write`, `documents:delete`, `upload`, `ai:ask`, `settings:read`, `shares:manage`, `spaces:manage`. Household administration and settings changes (`household:admin`, `settings:write`) can't be put on a token. On every request the effective scopes are the token's scopes intersected with what the member's household role currently allows.
- **Mandatory expiry**: 1 to 365 days, chosen at creation. There are no non-expiring tokens.
- **Revocable, with usage visible**: the list shows name, scopes, created, expires, last used (time and address, updated at most once a minute), and expired/revoked state. A member revokes their own tokens without step-up. Removing a member revokes all of that member's tokens.
- **Creating a token needs step-up** (a passkey confirmation within 5 minutes), as ADR-010 §3 requires. A token can't create, list or revoke tokens itself.
- **Use**: `Authorization: Bearer akt_pat_…` on any member API route the token's scopes cover. Policy still decides per document exactly as for the member's browser session (spaces, shares, 404 on denial). Share-access audit records token reads like session reads.
- **Never allowed for a token** (403 `session_required`), whatever its scopes:
  - credential and session management (`/auth/sessions*`, `/auth/passkeys*`, `/auth/recovery-codes`, `/auth/step-up/*`, `/auth/tokens*`);
  - every step-up route;
  - the live-counts event stream.
  
  `GET /auth/me` is allowed so a script can check who it is.
- **Bearer wins over the cookie**: a request that carries an `Authorization` header is authenticated by that header alone. A wrong, expired or revoked token is 401 and never falls back to a session cookie. The `akt_pat_` prefix sends the request to the token check and `akt_svc_` to the service-credential check; any other bearer value is 401.
- **Audit**: token created, revoked and expired-then-used go to `credential_audit`. Failed token attempts are rate-limited per client address, using the same Postgres limiter as login.
- Docs: `api-reference.md` (authentication section + curl example), CLAUDE.md, ADR-010 "As built", a runbook note on revoking a leaked token.

## Non-goals

- OAuth 2.1 / device authorization grant (ADR-010 phase 3).
- Tokens owned by the household or a space rather than one member, and tokens for the worker (service credentials cover that).
- The household admin viewing or revoking another member's tokens (later; member removal already revokes them).
- Fine-grained per-space or per-document token restrictions beyond scopes + the member's policy.
- Token rotation / refresh. A token is replaced by creating a new one and revoking the old one.

## Capabilities

### New Capabilities
- `auth-personal-access-tokens`: how members create, use, see and revoke personal access tokens; what a token may and may not reach; expiry, scope limits and audit.

### Modified Capabilities
<!-- none: main specs are not kept in this repo; requirements are written as ADDED -->

## Impact

- **API**: new table `personal_access_tokens` (`schema.ts` + `schema.sql`), `auth/tokens.service.ts` + `auth/tokens.controller.ts` (`GET/POST /api/auth/tokens`, `DELETE /api/auth/tokens/:id`), bearer resolution in `AuthGuard` and `UserOrInternalGuard`, `MemberPrincipal` gains `tokenId` / `clientId: "pat"`, `authorize()` refuses tokens on session-only routes (`@SessionOnly()` marker, empty-scope routes, step-up routes), member removal revokes tokens, the sweep prunes old rows, `route-inventory.test.ts` pins the session-only list.
- **Core**: `bearerValue` (from `service-credentials`) is reused; nothing new.
- **SPA**: `components/settings/Zugriffstokens.vue` in `/settings → Konto` (list, create dialog with scopes + expiry, show-once value with copy, revoke), `useTokens` composable.
- **Docs**: api-reference, configuration (none: no new env vars), CLAUDE.md, ADR-010 As built, `docs/runbooks/rotate-api-keys.md` (revoke a leaked token).
- **Deploy**: schema only (created by `applySchema` at api start); no env change, no migration step beyond the routine upgrade.
