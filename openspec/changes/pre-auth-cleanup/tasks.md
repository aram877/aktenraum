## 1. Core helper

- [x] 1.1 `packages/aktenraum-core/src/secrets.ts`: `secretMatches(provided: unknown, expected: string)` — SHA-256 both sides, `timingSafeEqual`, false for empty expected / non-string provided; export from `index.ts`
- [x] 1.2 Tests: match, mismatch, different length, empty expected, non-string (`undefined`, array)

## 2. API guards

- [x] 2.1 `auth/internal.guard.ts`: `InternalGuard` (`401 Bad secret`) and `UserOrInternalGuard` (present secret must match → else `401 Invalid secret`; absent → `AuthGuard.canActivate`); provide + export from `AuthModule`
- [x] 2.2 `settings.controller.ts`: internal endpoints use `@UseGuards(InternalGuard)`; delete `requireSecret`, `secretsMatch`, the `@Headers` params and the `node:crypto` import
- [x] 2.3 `type-fields.controller.ts`: `PATCH` uses `@UseGuards(UserOrInternalGuard)`; delete `requireUserOrSecret`, `secretsMatch`, the `AuthService` / `SETTINGS` dependencies and the `@Headers` / `@Req` params
- [x] 2.4 `common/middleware.ts`: `createCsrfMiddleware()` without a secret, `isCsrfAllowed` without `hasInternalSecret`, delete `internalSecretMatches`; update `main.ts` and `test/harness.ts`

## 3. Worker

- [x] 3.1 `webhook.ts`: replace the local `secretMatches` with the core helper

## 4. Tests

- [x] 4.1 `middleware.test.ts`: drop the `hasInternalSecret` cases
- [x] 4.2 `security.routes.test.ts`: replace "CSRF skipped with correct secret" with "cross-site + correct secret → 403"
- [x] 4.3 Type-fields route tests: secret without cookie → 200; cookie without secret → 200; cookie + wrong secret → 401 `Invalid secret`; neither → 401 `Not authenticated`
- [x] 4.4 Existing secret-gated settings tests still pass unchanged (status codes + bodies)

## 5. Docs + verify

- [x] 5.1 ADR-003 note: secret bypass removed (why); CLAUDE.md CSRF gotcha row updated
- [x] 5.2 `pnpm -r lint`, `pnpm -r build`, `pnpm -r test`, api + web typecheck
- [x] 5.3 `task build`; live: worker logs show no `type_specific_pass_failed` / active-model fallback after a reprocess; `/settings` still saves; a cross-site POST with the secret is 403
