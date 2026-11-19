## Why

ADR-010 step 2. Today an authenticated request carries `request.user: AuthUser = {id, username, passwordHash}`: no notion of what kind of caller it is, what it may do, or which documents it may touch, and the password hash travels with every request. Every authenticated caller can call every route.

Tenancy (ADR-009, step 3) and passkeys (step 4) both need one place where "who is calling" and "may they do this" are decided. Building that place now, while there is still exactly one user, means the later steps change the *decisions* without touching the ~55 routes again.

## What Changes

- **`Principal`** replaces `AuthUser` on the request: `{kind: "member", memberId, username, householdRole, scopes, sessionId, authTime, clientId}` or `{kind: "service", service: "worker", scopes}`. No secrets. `AuthGuard` builds a member principal, `InternalGuard` / `UserOrInternalGuard` a service principal. `@CurrentPrincipal()` replaces `@CurrentUser()`.
- **Scopes on every route.** `@RequireScope(...)` declares which scope a route needs (any of the listed). The auth guards check it after authenticating (`403 Insufficient scope`). A guarded route without a declaration is refused (fail closed) and a test enumerates every route so none ships undeclared. Member scopes derive from the household role; until members exist (step 3) every user is the household admin and holds all member scopes. The worker principal holds only `internal:settings-read` and `internal:type-fields-write`.
- **`PolicyService`** decides document access: `canAccessDocument(principal, docId, action)` for `read | write | delete`. Routes with a `:doc_id` declare `@DocumentAccess(action)`; the guard asks the policy and answers `404 Document N not found` on denial (no existence leak). Today the policy allows every member and only lets the worker write type fields; step 3 makes it real (home space, shares).
- **Change password** loads the member's hash from the database instead of reading it from the request.
- No behaviour change for the single user: same routes, same responses.

## Non-goals

- No households, members, spaces or shares (ADR-009, step 3).
- No new login mechanism or sessions table: `sessionId` stays `null` with JWT cookies (step 4).
- No list filtering in the policy: list isolation arrives with per-member Paperless tokens in step 3 (Paperless filters lists itself, verified in the ADR-009 spike).
- No SPA changes.

## Capabilities

### New Capabilities
- `request-authorization`: principal model, route scopes, document access policy.

## Impact

- **API** (`services/aktenraum-api/src/`): new `auth/principal.ts` (types, scopes, decorators, `authorize`), new `policy/` module (`PolicyService`); `auth/auth.guard.ts`, `auth/internal.guard.ts`, `auth/auth.module.ts`, `auth/auth.controller.ts` reworked; every controller gets `@RequireScope` (and `@DocumentAccess` where it takes `:doc_id`); `settings.controller.ts` uses the principal's username.
- **Tests**: principal/scope unit tests, policy unit tests, a route-inventory test (every guarded route declares a scope), insufficient-scope and document-denial cases.
- **Docs**: CLAUDE.md (aktenraum-api notes, test counts), `nestjs-route-pattern` skill (new route checklist item), session note.
- No schema, env, compose or SPA changes.
