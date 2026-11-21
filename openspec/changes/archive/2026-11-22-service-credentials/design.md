# Design

## Context

Today's internal authentication (after `pre-auth-cleanup` and `principal-and-policy`):

- **One comparison**: `secretMatches(provided, expected)` in `@aktenraum/core` (constant time over SHA-256 digests, rejects arrays and empty values).
- **api**: `InternalGuard` (secret only; `/api/settings/active-*`, `/api/tenancy/*`) and `UserOrInternalGuard` (secret when the header is present, otherwise `AuthGuard`; `PATCH /api/documents/:id/type-fields`). Both read `X-Aktenraum-Secret` and produce `workerPrincipal()` with `WORKER_SCOPES` (`internal:settings-read`, `internal:type-fields-write`, `internal:tenancy-write`, `internal:tenancy-read`). Scopes and route inventory are already enforced (`@RequireScope`, `test/route-inventory.test.ts`).
- **worker**: `webhook.ts` checks the same header on `/trigger/{extract,propagate,reindex-metadata}` and `/processing`. Callers: Paperless's `post_consume.sh` (extract only) and the api's `AutoTaggerClient` (all four).
- **worker → api clients**: `active-model.ts`, `auto-approve-config.ts`, `home-space.ts`, `space-lookup.ts`, `type-fields.ts`, `backfill.ts`. Each adds the header when `WEBHOOK_SECRET` is set.
- CSRF no longer looks at the secret (finding B is fixed). Every container except nginx loads the whole `docker/.env` via `env_file`.

See proposal.md for motivation; the spec `auth-service-credentials` holds the requirements.

## Goals / Non-Goals

**Goals:**
- Distinguishable callers, least privilege per caller, a single verification helper used on both sides.
- Keep the fail-closed behaviour and the "a wrong credential never falls back to the cookie" rule.
- A token format that step 6 (personal access tokens, also `Authorization: Bearer`) can sit next to without ambiguity.

**Non-Goals:**
- Changing the worker principal's api scopes (they already match ADR-010 §7, extended by tenancy).
- Per-request signing, replay protection, mTLS.

## Decisions

### D1. Token format `akt_svc_<43 chars base64url>` (32 random bytes)
`bootstrap-secrets.sh` generates `akt_svc_` + base64url of 32 bytes from `openssl rand`. The prefix makes secret scanners and humans recognise a leaked value. It also lets a guard tell "this is a service credential" apart from a future `akt_pat_` token without comparing against every PAT hash. The prefix only decides *which* check runs; the comparison itself is still constant time over the whole value. Services accept any non-empty value (an operator may paste their own), but log `service_token_weak` when one is shorter than 32 characters.
*Alternative*: reuse the base64 format of `WEBHOOK_SECRET`. Rejected: there's no cheap way to tell the token types apart once PATs arrive.

### D2. One helper: `serviceCaller(header, credentials)`
`@aktenraum/core` gets `serviceCaller(authorization: unknown, credentials: Partial<Record<ServiceName, string>>): ServiceName | null`, where `ServiceName = "paperless-hook" | "worker" | "api"`. It parses exactly `Bearer <value>` (case-insensitive scheme, one space, and anything that isn't a string, such as a repeated header, is rejected). It then runs `secretMatches` against **every** configured credential without stopping early, and returns the single matching name. Empty credentials never match (already true of `secretMatches`). A second helper, `checkServiceCredentials(credentials)`, returns `{ unset: ServiceName[], duplicate: ServiceName[], weak: ServiceName[] }` for the startup log. Both services drop duplicated values from the map they verify against, so a duplicate fails closed.
*Alternative*: one guard class per service. Rejected: there would be two copies of the parsing rules, which was finding C all over again.

### D3. Worker: an allowance table instead of scopes
`webhook.ts` gets `ALLOWED: Record<Route, ServiceName[]>`: `extract → [paperless-hook, api]`, `propagate`, `reindex-metadata` and `processing → [api]`. An unrecognised credential gets **401** (`webhook_rejected`, `reason: "unknown_credential"`). A recognised caller outside the table gets **403** (`reason: "not_allowed"`, `caller`, `route`). `webhook_enqueued` gains `caller`. Four routes don't justify a scope vocabulary in the worker; the table is the whole policy and is tested as such.
*Alternative*: port the api's scope model to the worker. Rejected as overhead; reconsider if the worker grows more routes.

### D4. api: same guards, new source of identity
`InternalGuard` and `UserOrInternalGuard` call `serviceCaller(request.headers.authorization, { worker: SVC_TOKEN_WORKER })`. Only the worker credential is in the api's verification map, so a hook or api token counts as unknown (401). That is equivalent to the spec's "not accepted as the worker", and it avoids handing the api the hook token at all. `UserOrInternalGuard`: no `Authorization` header → `AuthGuard` (cookie) as today; header present → it must be the worker credential, otherwise 401 `Invalid credential`. There's no cookie fallback. The produced principal, its scopes and `authorize()` stay unchanged, so route-level 403 for out-of-scope worker calls is already covered. `AutoTaggerClient` sends `Authorization: Bearer ${SVC_TOKEN_API}`. The browser never sends `Authorization` to the api (cookie sessions only), so the header can't come from the SPA.

### D5. Per-container credentials via compose overrides
Every service keeps `env_file: .env` (one file, ADR-002), and the values a container must not hold are overridden to empty in its `environment:` block, which takes precedence over `env_file`:

| Container | hook | worker | api |
| --- | --- | --- | --- |
| paperless | as `AKTENRAUM_HOOK_TOKEN` (others blank) | blank | blank |
| auto-tagger | verify | send | verify |
| aktenraum-api | blank | verify | send |
| backup | blank | blank | blank |

`post_consume.sh` sends `Authorization: Bearer ${AKTENRAUM_HOOK_TOKEN}`. The compose `images` CI job's `docker compose config` check catches typos in variable names.
*Alternative*: separate env files per service. Rejected: it breaks the one-file model that `bootstrap-secrets.sh`, the runbooks and the desktop app rely on.

### D6. Hard cutover, `WEBHOOK_SECRET` kept for rollback
No service reads `WEBHOOK_SECRET` or `X-Aktenraum-Secret` any more. All three services come from one compose project and are recreated together, so a dual-accept window would only add an attack surface that nobody ever removes. `bootstrap-secrets.sh` stops generating `WEBHOOK_SECRET` for new installs but never deletes it, and `.env.example` marks it retired. This is the same pattern as `JWT_SECRET`.

### D7. Tests
- core: `serviceCaller` parsing (scheme case, missing value, arrays, extra spaces), no-early-exit behaviour by construction (every credential compared, single match returned), duplicates and `checkServiceCredentials`.
- worker: the allowance matrix (3 callers × 4 routes plus unknown and missing), the `caller` field in the log, and the clients sending the bearer header (`home-space.test.ts`, `space-lookup.test.ts` and `pipeline.test.ts` switch from `X-Aktenraum-Secret`).
- api: `internal-guard.routes.test.ts`, `routes.test.ts`, `security.routes.test.ts`, `home-space`, `space-scoping` and `upload-space` move to a harness helper `asWorker(req)`. New cases: the old header gives 401, the api token gives 401, and a wrong bearer plus a valid cookie gives 401.
- e2e: `docker-compose.e2e.yml` gets three distinct tokens. `scripts/e2e-worker.sh` already proves the hook → extraction path end to end and gains one assertion: the hook token on `/trigger/propagate` returns 403.

## Risks / Trade-offs

- [The worker holds the hook and api tokens, so a compromised worker can impersonate both] → That's inherent: whoever verifies a shared secret holds it. Hash-based verification would only help against an environment leak of a single container, and the worker already holds the Paperless superuser token. Documented as accepted.
- [Everything else in `.env` (Paperless superuser token, DB password) is still visible to every container] → Out of scope; D5 only narrows the new credentials. Noted for ADR-010 §8.
- [An operator edits `.env` and runs `docker compose restart`, so services run with old values] → The existing gotcha (restart doesn't re-read env) applies. The runbook uses `up -d`, and a mismatch only shows as 401s plus the 30 s poller still working.
- [The upgrade forgets `bootstrap-secrets.sh`] → Every service logs `service_token_unset` at startup and internal calls fail closed. Extraction still happens via the poller, but auto-approve rules and the active model fall back (`rules_unreachable_fail_closed`, env model). The runbook step and its "expected output" make this visible, and the health check could surface it later.
- [A future PAT whose value happens to start with `akt_svc_`] → PATs are minted by aktenraum with the `akt_pat_` prefix, so the namespaces can't collide.

## Migration Plan

1. `git pull`, then `bash scripts/bootstrap-secrets.sh`. It reports that the three `SVC_TOKEN_*` values were generated; `WEBHOOK_SECRET` stays.
2. `task build`. This rebuilds and recreates paperless (its environment changed), the api and the worker. No database or Qdrant change, so no backup gate beyond the routine one in the upgrade runbook.
3. Verify: no `service_token_unset` in `task logs SVC=auto-tagger` / `aktenraum-api`; upload a document and see `webhook_enqueued … caller=paperless-hook`; approve one and see `caller=api` on the propagate trigger; the library in-flight pin works (`/processing`); auto-approve rules load (no `rules_unreachable_fail_closed`).
4. Rollback: check out the previous commit and run `task build`. The old code reads `WEBHOOK_SECRET`, which is still in `.env`; the new `SVC_TOKEN_*` lines are ignored.

## Open Questions

- Should `GET /api/health` (or the settings page) report "service credentials misconfigured", the way it reports backup health? That can be added later without changing the spec.
