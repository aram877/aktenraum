# Tasks

## 1. Schema and lockout

- [x] 1.1 `member_removals` + `member_removal_documents` in `schema.ts`, `schema.sql` and the pg-mem harness (design §1). Verify: `apply-schema.test.ts` green. On a throwaway `postgres:15` (`docker run --rm`), apply twice, and the phase check constraint and FKs reject bad rows
- [x] 1.2 Removed-member filtering: `TenancyService.findMember` returns a removed marker, and `resolveMember` skips the reconcile for it and returns `null`. `listMembers`, `directory`, `SpacesService.householdMember`, `SharesService.assertHouseholdMember` and the household member count skip removed members. Verify: route tests. A removed member's cookie gets 401 on one route per controller. A removed member is absent from members/directory, can't be added to a space or receive a share (404/422), and `household_member_count` drops
- [x] 1.3 `AuthService.login` rejects a removed member after the bcrypt compare, with the wrong-password answer, and counts it towards the throttle. Invite redemption with a removed member's username → 409. Verify: auth route tests (same status and body as a wrong password; the throttle counts it; 409 on redeem)

## 2. Removal core

- [x] 2.1 `PaperlessGateway` / `PaperlessTenancyPort`: deactivate a user (`is_active: false`, `groups: []`). The fake Paperless rejects tokens of inactive users. Verify: gateway test + fake test
- [x] 2.2 `MemberRemovalService` validation + lockout step (design §2 step 1): admin only (scope), not admin/self (409), confirmation (422), successor default/valid (422), already removed (404). Insert the row, forget the gateway, delete the stored token. Verify: route tests for every refusal (nothing changes) and for the lockout (session 401 right after the insert, token row gone)
- [x] 2.3 Phase `db` (design §2 step 2): record affected documents, move the personal-space documents, transfer shared-space ownership (successor promoted from editor/viewer), drop other memberships, revoke received shares and shares to the new home-space members with audit `revoked` by the admin. Idempotent. Verify: route tests against the three-member fixture (`src/test/household.ts`) for each spec scenario, plus running phase `db` twice yields the same state
- [x] 2.4 Phase `derived` (design §2 step 3): deactivate the Paperless user, `syncSpaceMembership` for changed spaces, mirror + `setSpaceByDocId` per affected document with `synced_at`, forget the successor's gateway, `phase='done'`. Failures are stored in `last_error` and the request answers 200 `completing`. Verify: route tests. Paperless permissions and the Qdrant payload match afterwards. A Paperless failure on document N leaves `completing` with documents < N synced, and a re-run finishes without re-PATCHing synced documents
- [x] 2.5 Trashed documents (design §4): service-gateway restore → mirror → trash again; a hard-deleted document is marked synced and its `document_spaces` row dropped. Verify: tests with a trashed and a vanished affected document. After the removal the successor's own token lists the trashed document in `/api/trash` and can restore it
- [x] 2.6 Removal sync: `onApplicationBootstrap` + 5-minute timer, per-member lock, logs `member_removal_completed` / `member_removal_incomplete`. Verify: tests. An incomplete removal completes on the next sync run, and two concurrent runs don't double-process (lock)
- [x] 2.7 `HomeSpaceService.personalSpaceOf` follows successors (chain, depth cap, admin fallback). Verify: home-space route tests. An upload by a removed member, finished after the removal, lands in the successor's personal space, also with an `upload_task_spaces` row for a space the member lost. A chained successor resolves

## 3. API routes

- [x] 3.1 `GET /household/members/:id/removal-preview`, `POST /household/members/:id/remove`, `GET /household/removals` with `household:admin`, zod bodies, `{detail}` errors; route inventory updated. Verify: route tests (non-admin 403, preview changes nothing and its counts match what the removal then does, removals list shows `completing` → `done`)
- [x] 3.2 Document the three routes in `docs/api-reference.md`. Verify: the documented shapes match the route test responses

## 4. Web

- [x] 4.1 `useHousehold`: `useRemovalPreview(memberId, successorId)` query, `useRemoveMember` mutation (invalidates household, spaces, shares, library), `useRemovals` with 10 s polling while any removal is incomplete. Verify: composable tests (key shape, invalidation, polling stops once all are done)
- [x] 4.2 `Mitglieder.vue`: "Entfernen" per non-admin member, a dialog with successor select (default: me), preview text, and a typed-username confirm (button disabled until it matches). Below the list, "Entfernte Mitglieder" with the "wird abgeschlossen" pill. Verify: `mountSuspended` tests (no button for the admin, confirm gating, the right request body, the pill while completing)
- [x] 4.3 Full suite green: `pnpm -r lint`, `pnpm -r build`, api + web typecheck, `pnpm -r test`

## 5. Rehearsal and docs

- [x] 5.1 e2e rehearsal (throwaway stack, three members): B with personal documents (one trashed), owning a shared space with C as editor and A as viewer, an editor in A's space, a share received from C and one granted to C and one to A. Remove B with successor A. Check: B's session 401, login refused, B's Paperless token refused, A owns everything, C keeps the share from B, the share to A ended, the trashed document is restorable by A, Ask cites a former B document for A. Repeat with Paperless stopped mid-removal: `completing` → `done` after it is back. Plus worker e2e `bash scripts/e2e-worker.sh`
- [x] 5.2 ADR-009 "as built" note for removal (incl. rollback caveat and trash-clock reset), CLAUDE.md (household notes, gotcha row, test counts, OpenSpec status), session note. Verify: the docs name the new routes, the tables and the rollback step

## Workflow follow-up

- Live deploy via `docs/runbooks/upgrade-existing-install.md` (no data change; tables created at startup).
- `/opsx:archive tenancy-member-removal`.
