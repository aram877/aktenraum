## 1. Principal, scopes, decorators

- [x] 1.1 `auth/principal.ts`: `Scope` union + `MEMBER_SCOPES` / `memberScopes(role)` / `WORKER_SCOPES`; `MemberPrincipal`, `ServicePrincipal`, `Principal`; `PrincipalRequest`
- [x] 1.2 Decorators: `@RequireScope(...scopes)`, `@DocumentAccess(action)`, `@CurrentPrincipal()`
- [x] 1.3 `authorize(context, principal, reflector, policy)`: missing declaration → 403, no matching scope → 403, document action → policy → 404

## 2. Policy

- [x] 2.1 `policy/policy.service.ts` + `policy/policy.module.ts`: `canAccessDocument(principal, docId, action)` (member → allow; service → write with `internal:type-fields-write`)
- [x] 2.2 `AuthModule` imports `PolicyModule`

## 3. Guards + auth controller

- [x] 3.1 `AuthGuard`: member principal from the verified user, then `authorize`
- [x] 3.2 `InternalGuard` / `UserOrInternalGuard`: worker principal, then `authorize`
- [x] 3.3 Remove `request.user`, `AuthenticatedRequest`, `CurrentUser`
- [x] 3.4 `auth.controller.ts`: `me` from the principal; `change-password` loads the hash via `findById(memberId)`
- [x] 3.5 `settings.controller.ts`: `replaceRules(body, principal.username)`

## 4. Route declarations

- [x] 4.1 `@RequireScope` on every guarded route per the design's scope map
- [x] 4.2 `@DocumentAccess` on every `:doc_id` route

## 5. Tests

- [x] 5.1 Unit: `memberScopes`, `authorize` (undeclared, insufficient, any-of, empty list, document denial → 404), `PolicyService`
- [x] 5.2 Route inventory: every guarded route declares a scope; `:doc_id` routes declare a document action; public allowlist explicit
- [x] 5.3 Route: worker secret on a member-only route stays 401; change-password still works; existing suites unchanged

## 6. Docs + verify

- [x] 6.1 CLAUDE.md (aktenraum-api notes, test counts), `nestjs-route-pattern` skill checklist, session note
- [x] 6.2 `pnpm -r lint`, `pnpm -r build`, `pnpm -r test`, api + web typecheck
- [x] 6.3 `task build`; live: the SPA works as before (library, detail, star, settings save), worker calls still 200 — library, detail and star authorization checked in the browser by the maintainer; settings save covered by route tests only. The star itself not persisting is a separate, older gateway bug (fixed in the next commit)
