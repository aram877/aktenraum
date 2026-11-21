# Tasks

## 1. Storage and token service (api)

- [ ] 1.1 Add the `personal_access_tokens` table (D2) to `services/aktenraum-api/src/db/schema.ts` and `schema.sql` (unique `token_hash`, index on `member_id`); verify with `apply-schema.test.ts` and by applying `schema.sql` twice to a throwaway `postgres:15` (`docker run --rm`), including the expiry expression from D2 on both pg-mem and real Postgres.
- [ ] 1.2 Add `TOKEN_SCOPES` to `auth/principal.ts` and `auth/tokens.service.ts` with `create` (D1 format, sha256, display prefix, 25-active cap, expiry in SQL), `list`, `revoke` (own only), `resolve(value, ip)` (one query for the active token + member, throttled `last_used_*` write per D6, fire-and-forget) and `revokeAllOfMember`; verify with unit tests over pg-mem (value never stored, cap, expiry boundary, revoked/expired → null, usage write at most once a minute, scope list validated on read).

## 2. Bearer authentication and the token boundary (api)

- [ ] 2.1 Add `auth/bearer.ts` (D3) and use it in `AuthGuard` (header present → PAT only, no cookie), `UserOrInternalGuard` (`akt_svc_` → worker, `akt_pat_` → PAT) and `InternalGuard` (PAT → 401); the member principal gets `clientId: "pat"`, `tokenId`, `authMethod: "token"`, scopes = token ∩ role; verify with route tests: a token reads the library and uploads as its member, a missing scope → 403, a foreign document → 404, revoked/expired/unknown/malformed token + valid cookie → 401, a PAT on `/api/settings/active-*` → 401, existing service-credential tests unchanged.
- [ ] 2.2 Add `@AllowToken()` / `@SessionOnly()` and the deny-by-default rule in `authorize()` (D4: empty-scope routes except `GET /auth/me`, step-up routes, session-only routes → 403 `session_required`); mark the live-counts stream session-only; extend `test/route-inventory.test.ts` with the pinned lists and a walk asserting every step-up / empty-scope / session-only route answers a valid token with 403 `session_required`; verify with `pnpm --filter @aktenraum/api test`.
- [ ] 2.3 Rate-limit failed token attempts per client address and write the audit events (D7: `token:ip:` key, 429 + `Retry-After`, `token_created`, `token_revoked`, `token_rejected_expired` at most hourly, no values); verify with route tests for the 11th bad attempt → 429, a valid token from a throttled address → 429, and audit rows without the value (grep the stored detail for `akt_pat_` beyond the display prefix).

## 3. Token routes, member removal, sweep (api)

- [ ] 3.1 Add `auth/tokens.controller.ts` (D8: `GET/POST /api/auth/tokens`, `DELETE /api/auth/tokens/:id`, zod schemas, step-up on POST, session-only) and extend `/auth/me` with `auth_method: "token"` + `token_name`; verify with route tests: create returns the value once and list never does, 422 for bad name/scopes/expiry incl. `household:admin`, 403 `step_up_required` without step-up, 409 at the cap, another member's id → 404, revoke works without step-up and the token is 401 afterwards, a token on these routes → 403 `session_required`.
- [ ] 3.2 Revoke a member's tokens in `MemberRemovalService.remove` (`member_removed`, actor = admin) and prune revoked/expired tokens older than 30 days in `AuthSweepService`; verify with the member-removal route test (token 401 after removal, rows revoked) and a sweep test.
- [ ] 3.3 Document the api side: `docs/api-reference.md` (authentication section: bearer tokens, scopes, the session-only list, error codes, curl example for upload and library), `docs/runbooks/rotate-api-keys.md` (revoke a leaked token), the `nestjs-route-pattern` skill (`@AllowToken` / `@SessionOnly`, tokens and step-up); verify by reading the rendered sections against the routes.

## 4. SPA

- [ ] 4.1 Add `composables/useTokens.ts` and `components/settings/Zugriffstokens.vue` under `/settings → Konto` (D10: list with status/last use, create dialog with scope checkboxes + expiry, show-once value with copy + warning, two-click revoke; step-up through `useApi`); verify with `mountSuspended` tests (list rendering incl. expired/revoked, create flow shows the value once and clears it on close, revoke invalidates the query, 403 `step_up_required` triggers the step-up path) and `pnpm --filter @aktenraum/web test` + `typecheck`.

## 5. Integration

- [ ] 5.1 Update CLAUDE.md (credentials table row, "What's implemented" row, Restricted-sessions / step-up gotcha rows mention `session_required`, aktenraum-api notes, roadmap paragraph, test counts) and add "As built (`personal-access-tokens`)" to ADR-010; then run `pnpm -r lint`, `pnpm -r build`, api + web typecheck and `pnpm -r test`; verify all green and record the counts.
- [ ] 5.2 Rehearse on the throwaway e2e stack (`scripts/spikes/pat-rehearsal.mjs`, using `e2e-session.mjs` for a stepped-up session): create a token with `upload` + `documents:read`, upload a document with it and see it extracted, list the library, get 403 `session_required` on `POST /trash/empty` and `GET /auth/tokens`, revoke, then get 401; verify by recording the output in the session note.

## Workflow follow-up

- Live deploy (needs the maintainer's go-ahead): `task build`, then create a first token in `/settings → Konto → Zugriffstokens` and try it with curl.
- Session note `docs/sessions/YYYY-MM-DD.md`, then archive with `/opsx:archive`.
