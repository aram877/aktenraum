## Context

The api authenticates browser requests in `AuthGuard` (session cookie → `AuthService.verifySession`) and internal requests by comparing `X-Aktenraum-Secret` with `WEBHOOK_SECRET`. The comparison lives in four places, the type-fields route does both checks in its controller, and the CSRF middleware treats a matching secret as a reason to skip its check. ADR-010 will replace both mechanisms; this change consolidates them first without changing behaviour.

## Goals / Non-Goals

**Goals:** every identity decision for an api route happens in a guard; one comparison implementation shared by api and worker; CSRF depends only on browser signals.

**Non-goals:** new auth mechanisms, new env vars, changes to response codes or bodies.

## Decisions

**Helper in `@aktenraum/core`, not in the api.** The worker needs the same comparison and already depends on core; a copy in each service would recreate finding C. Signature `secretMatches(provided: unknown, expected: string): boolean` accepts the raw header value (`string | string[] | undefined`) so callers don't pre-validate.

**Compare SHA-256 digests.** `timingSafeEqual` needs equal-length buffers; the old code returned early on a length mismatch, which leaks the length. Hashing both sides to 32 bytes removes that and keeps the comparison constant-time. Cost is negligible at our request rates.

**Two guards instead of one configurable guard.** `InternalGuard` (secret only) and `UserOrInternalGuard` (secret if present, else `AuthGuard`) read clearly at the route and map 1:1 onto ADR-010's future `kind: "service"` / `kind: "member"` principals. `UserOrInternalGuard` injects `AuthGuard` and calls its `canActivate`, so the cookie logic exists exactly once.

**A present-but-wrong secret never falls back to the cookie.** That's today's behaviour in `requireUserOrSecret` (`401 Invalid secret`). It stops a request from presenting a guessed secret and a stolen cookie and getting the more permissive of the two.

**Drop the CSRF secret bypass rather than move it.** It was added for internal callers (ADR-003), but the CSRF check only rejects requests whose `Sec-Fetch-Site` is present and not same-origin/same-site/none, and Node's `fetch` sends no `Sec-Fetch-Site` (verified on Node 22.23 in the worker image: it sends `sec-fetch-mode` only). `post_consume.sh` calls the worker, not the api. So no internal caller depends on the bypass, and removing it closes the path where a leaked secret also disables CSRF protection for a browser session. The ADR-003 note about a future Tauri WebView needing the header no longer applies; ADR-010 routes desktop sign-in through the system browser.

## Risks / Trade-offs

- **A future internal caller that sends `Sec-Fetch-Site: cross-site`** (e.g. a browser-based tool) would now be blocked. Acceptable: such a caller should use a bearer service credential (ADR-010 step 5), which is not cookie-authenticated and therefore not a CSRF target.
- **Error messages must stay identical** because tests and the worker logs rely on them. The guards reuse the exact strings.

## Migration Plan

Pure refactor; deploy with `task build`. No data, env or compose changes. Rollback is `git revert`.
