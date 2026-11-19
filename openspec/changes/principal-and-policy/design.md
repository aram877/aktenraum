## Context

After `pre-auth-cleanup`, identity is decided only in three guards (`AuthGuard`, `InternalGuard`, `UserOrInternalGuard`). This change makes those guards produce a `Principal` and run the authorization step, so controllers stay free of auth logic.

## Decisions

**Authorization runs inside the auth guards, not in a separate global guard.** Nest runs global guards before route guards, so a global `ScopesGuard` would run before the principal exists. Each auth guard ends with the shared `authorize(context, principal)`; there is exactly one implementation.

**`@RequireScope(...)` means "any of".** Almost every route lists one scope. `PATCH /documents/:id/type-fields` is the one route both the worker and a user call; with any-of it lists `documents:write` and `internal:type-fields-write` instead of granting the worker a broad `documents:write`.

**`@RequireScope()` with no arguments = authenticated only.** Used for `/auth/me` and `/auth/change-password`. That keeps "declared but open to any member" distinct from "forgot to declare".

**Fail closed on a missing declaration, and test for it.** A guarded route with no `@RequireScope` answers `403 Route has no scope declaration`. A test walks every controller's routes via Nest's route metadata and fails if any guarded route lacks a declaration, so the runtime refusal never reaches production. Public routes (`/auth/login`, `/auth/logout`, `/health`) are an explicit allowlist in that test.

**Scopes derive from the household role.** `memberScopes("admin")` is every member scope; `memberScopes("member")` drops `settings:write` and `household:admin`. There is no role column yet; until step 3 every user is `admin`, which is today's behaviour.

**Document denial is 404, not 403.** The detail endpoints already 404 for unknown ids, and Paperless 404s documents a user can't see (ADR-009 spike). Answering 403 would confirm that a document exists.

**`PolicyService` in its own module.** It belongs to the domain (ADR-009), not to authentication; `AuthModule` imports `PolicyModule` because the guards call it. Step 3 gives it a database and Paperless dependency without touching the guards.

**`householdId` is left out of the principal for now.** There is no household table; a hard-coded id would look real and be wrong. Step 3 adds it with the table.

## Scope map

| Scope | Routes |
| --- | --- |
| `documents:read` | library list/tags/types, inbox list/detail/preview, document status/detail/preview/download/duplicate-candidates/in-flight/processing/task, type-field schema + read, events counts, ingest activity, trash list |
| `documents:write` | inbox patch/approve/reject, document fields/reprocess/reprocess-failed/star/unstar/dismiss-duplicate, type-field write (with `internal:type-fields-write`) |
| `documents:delete` | delete to trash, trash restore/delete forever/empty |
| `upload` | upload |
| `ai:ask` | `/ai/find`, `/ai/answer`, `/ai/answer/stream` |
| `settings:read` | LLM/answer-LLM/available models/auto-approve read, backup health |
| `settings:write` | LLM/answer-LLM patch, auto-approve put |
| `internal:settings-read` | `/settings/active-*` (worker) |
| (authenticated) | `/auth/me`, `/auth/change-password` |

`household:admin` and `shares:manage` are defined for step 3 and not used by any route yet.

## Risks / Trade-offs

- **A route added without `@RequireScope` breaks at runtime (403)** — intended; the inventory test catches it first.
- **Restore from trash counts as `delete`.** Trash management is owner-only in ADR-009; grouping it with delete keeps one rule.

## Migration Plan

Pure refactor; `task build`. No data, env or compose change. Rollback is `git revert`.
