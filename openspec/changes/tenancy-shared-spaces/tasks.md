## 1. Schema + Paperless mirror

- [x] 1.1 `space_paperless_groups` and `upload_task_spaces` in `schema.ts`, `schema.sql`, harness; verify on a throwaway `postgres:15` (apply twice + constraints)
- [x] 1.2 `paperless-mirror.ts`: viewer group `space-<id>-view`; shared-space document target `view=[writer, viewer]`, `change=[writer]`; personal target unchanged (test: existing personal documents mirror as `unchanged`)
- [x] 1.3 `syncSpaceMembership` + `removeFromSpaceGroups` (idempotent group-set diff per member); fake Paperless enforces group view/change; tests incl. role change editor↔viewer and removal
- [x] 1.4 Worker startup reconcile: re-set Qdrant `space_id` for documents whose chunks disagree with their home space (`countChunksOutsideSpace`); test

## 2. Spaces API

- [x] 2.1 Scope `spaces:manage` (all members), `DocumentAction` `move` (owner only) in `PolicyService`; policy tests
- [x] 2.2 `spaces/` module: list (with `household_member_count`), create, rename, delete-when-empty; personal-space guards; 404 for spaces the caller isn't in
- [x] 2.3 Membership: list, add, change role, remove, leave; owner immutable; sync into Paperless + `MemberGateways.forget`
- [x] 2.4 `GET /api/household/directory` (any member)
- [x] 2.5 Move single + bulk with the compensation sequence (DB conditional update → service-gateway mirror → `setSpaceByDocId`); `VECTOR_STORE` injected; trash hard-delete also removes the `document_spaces` row
- [x] 2.6 Route inventory updated; route tests: create/rename/delete/409s, membership matrix (owner/editor/viewer/outsider), leave takes effect for library + counts + RAG access, move permissions, move compensation on Paperless failure and on Qdrant failure, bulk mixed results, existence not leaked

## 3. Upload, library, inbox

- [x] 3.1 Upload `space_id` (validated before sending, 403), `upload_task_spaces`; `HomeSpaceService` uses it, falls back to personal when revoked; tests
- [x] 3.2 Library rows + detail payloads carry `home_space`; `?space=` filter (member's spaces only)
- [ ] 3.3 Measure the `id__in` request-line limit on the e2e Paperless; implement the chunked fallback above the threshold; tests
- [x] 3.4 Inbox list + live-counts inbox number exclude viewer-space documents; tests (viewer, editor, single member unchanged)

## 4. Web

- [x] 4.1 `useSpaces` + mutations (create, rename, delete, members, leave, move, bulk move) with invalidation per the spa-data-fetching rules
- [x] 4.2 `/akten` page + nav entry (only when `household_member_count ≥ 2`)
- [x] 4.3 `/upload` space picker
- [x] 4.4 Library: Akte column/card line, Akte filter (`?space=`), archive-tab multi-select + "Verschieben nach…" with result summary
- [x] 4.5 "Verschieben" on `/library/[id]` and `/inbox/[id]` (owner of current space only)
- [x] 4.6 Tests (`mountSuspended`): hidden for one member, `/akten` owner vs editor vs viewer, upload picker, move flows

## 5. Docs + verify

- [ ] 5.1 Worker e2e (`bash scripts/e2e-worker.sh`) + a shared-space rehearsal on the e2e stack (create space, add viewer, upload into it, move in/out, isolation through both members' tokens)
- [ ] 5.2 ADR-009 "as built" note, CLAUDE.md (spaces, gotchas, counts), api-reference.md, session note
