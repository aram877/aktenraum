## Why

ADR-010 replaces the whole auth layer (passkeys, server-side sessions, `Principal`, per-service credentials). A read-only audit on 2026-11-19 found three places where today's code would undermine that work, because identity checks happen outside the one guard the rebuild will replace:

- **A.** `PATCH /api/documents/:id/type-fields` authenticates in the controller (`requireUserOrSecret` reads the session cookie and calls `AuthService.verifySession` itself). The next auth change would silently miss this route.
- **B.** The CSRF middleware skips its check for any request that carries the internal `X-Aktenraum-Secret`. Internal service identity and browser CSRF protection are tangled in one function, although internal callers never need the bypass: Node's `fetch` sends no `Sec-Fetch-Site` header (verified in the worker container on Node 22.23), and the CSRF check already allows requests without one.
- **C.** Four separate implementations of the constant-time secret comparison: `internalSecretMatches` (`common/middleware.ts`), `secretsMatch` (`settings.controller.ts`), `secretsMatch` (`type-fields.controller.ts`), `secretMatches` (worker `webhook.ts`).

Fixing them first keeps the auth rebuild a change to one guard instead of a hunt through controllers.

## What Changes

- **One comparison helper** in `@aktenraum/core` (`secretMatches(provided, expected)`): constant-time, false for an empty expected value or a non-string input, and compares SHA-256 digests so the secret's length doesn't leak. The api and the worker both use it; the four local copies are deleted.
- **`InternalGuard`** in the api: accepts a request only when `X-Aktenraum-Secret` matches `WEBHOOK_SECRET` (fail-closed when the secret is empty). Used by `GET /api/settings/active-llm-model` and `GET /api/settings/active-auto-approve-rules` instead of the controller's `requireSecret`.
- **`UserOrInternalGuard`** in the api: if `X-Aktenraum-Secret` is present it must match (wrong value → 401, no fallback to the cookie); otherwise it delegates to `AuthGuard`. Used by `PATCH /api/documents/:id/type-fields`; `requireUserOrSecret` and the controller's `AuthService` dependency are removed.
- **CSRF middleware without the secret bypass**: `createCsrfMiddleware()` takes no secret; `isCsrfAllowed` loses `hasInternalSecret`.
- No other behaviour changes. Status codes and error bodies stay the same (`401 Bad secret`, `401 Invalid secret`, `401 Not authenticated`, `403 Cross-site request blocked`). `WEBHOOK_SECRET` stays until ADR-010 step 5.

## Non-goals

- No `Principal`, scopes, sessions or passkeys (ADR-010 steps 2 and 4).
- No per-caller service credentials (ADR-010 step 5). The worker's own `/trigger/*` and `/processing` auth keeps the single secret; only its comparison function changes.
- No SSE session re-check (finding E, ADR-010 step 4).

## Capabilities

### New Capabilities
- `internal-auth`: how internal (service-to-service) requests are authenticated and how that interacts with user auth and CSRF.

## Impact

- **Core**: new `packages/aktenraum-core/src/secrets.ts`, exported from `index.ts`, with tests.
- **API** (`services/aktenraum-api/src/`): new `auth/internal.guard.ts` (`InternalGuard`, `UserOrInternalGuard`), exported from `AuthModule`; `settings/settings.controller.ts` and `type-fields/type-fields.controller.ts` drop their own checks; `common/middleware.ts` drops the secret parameter; `main.ts` + `test/harness.ts` call `createCsrfMiddleware()`; tests updated (`middleware.test.ts`, `security.routes.test.ts`, type-fields route tests).
- **Worker** (`services/auto-tagger/src/webhook.ts`): uses the core helper.
- **Docs**: ADR-003 note (no secret bypass any more), CLAUDE.md CSRF row, session note.
- No schema, env or compose changes.
