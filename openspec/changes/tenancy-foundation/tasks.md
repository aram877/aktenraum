## 0. Before starting

- [ ] 0.1 Re-read ADR-009 (incl. spike results + migration), ADR-010 §4 and this design; check `scripts/spikes/paperless-perm-spike*.mjs` still pass on the e2e stack (Paperless version unchanged?)

## 1. Schema + reconcile

- [x] 1.1 `households`, `members`, `spaces`, `space_members`, `document_spaces` in `db/schema.ts` **and** `db/schema.sql` (+ `apply-schema.test.ts`), plus the pg-mem harness schema
- [x] 1.2 `tenancy/` module: reconciler at startup (household, member per user — first is admin, personal space per member), idempotent
- [x] 1.3 Tests: fresh DB, existing user, restart idempotency, second `users` row becomes `member`

## 2. Principal + policy

- [x] 2.1 `MemberPrincipal`: `memberId` = `members.id`, add `userId`, `householdId`; guard resolves the member from the JWT's `users.id`; `change-password` uses `userId`
- [x] 2.2 `PolicyService`: space membership + role → action; no home space → admin only; service principals by scope
- [x] 2.3 Tests: policy matrix (viewer/editor/owner × read/write/delete, no home space, service)

## 3. Paperless mapping

- [x] 3.1 Gateway: create/find Paperless user (spike permission set) and group; set document `owner` + `set_permissions`; create tags/types/correspondents with `owner: null`
- [x] 3.2 Core `PaperlessClient.getOrCreateNamed` creates with `owner: null`; `bootstrap-paperless.sh` likewise
- [x] 3.3 Fake Paperless (`test/fake-gateway.ts`) + core fake: users, groups, owner/permissions
- [x] 3.4 Tests: provisioning idempotent, permission payload shape, `owner: null` on every create path

## 4. Home space for new documents

- [x] 4.1 Record the uploading member per Paperless task. `applySchema` can't add a column to `upload_tasks`, so use a new table (e.g. `upload_task_members(task_id, member_id)`) or an explicit migration — decide at implementation
- [x] 4.2 `POST /api/tenancy/assign-home-space` (`InternalGuard`, new worker scope `internal:tenancy-write`): pick the space, write `document_spaces`, apply Paperless permissions; idempotent
- [x] 4.3 Worker: call it before extraction (skip when the doc already has a home space); failure → defer like a transient LLM error, never extract unassigned
- [x] 4.4 Ingest: explicit source instead of "ownerless task = consume folder"
- [x] 4.5 Tests: upload / mail / folder routing, reprocess keeps the space, worker ordering

## 5. Space-aware AI

- [x] 5.1 Core `rag/vectorStore.ts`: `space_id` + `shared_with` payload fields and keyword indexes (created on `ensureCollection` when missing)
- [x] 5.2 Worker indexer writes them; api retrieval filters on the principal's spaces (+ `shared_with`)
- [x] 5.3 Few-shot exemplars, correspondent history hint, `findDuplicateIds` and the api's duplicate-candidates endpoint scoped to the home space
- [x] 5.4 Tests: filter construction, cross-space duplicate not flagged, few-shot excludes other spaces

## 6. Migration tool

- [ ] 6.1 `tenancy/migrate.ts` (`dist/tenancy/migrate.js`), steps 1–7 from the design, `--dry-run`, resumable, structured log per step
- [ ] 6.2 Backup gate (backup status file, all three tags < 2 h; `--i-have-a-backup` override)
- [ ] 6.3 `scripts/migrate-tenancy.sh` (Git Bash path handling as in `backfill-rag-index.sh`)
- [ ] 6.4 Tests: dry run writes nothing, re-run is a no-op, gate refuses, drift report

## 7. Rehearsal on the e2e stack

- [ ] 7.1 Seed: e2e corpus + ownerless documents + >200 tags
- [ ] 7.2 Dry run → real run → re-run → verification through the member's Paperless user; spike scripts still pass

## 8. Docs + verify

- [ ] 8.1 ADR-009 migration section (as executed), CLAUDE.md (schema, tenancy notes, gotchas, test counts), upgrade runbook (migration step), session note
- [ ] 8.2 `pnpm -r lint`, `pnpm -r build`, `pnpm -r test`, api + web typecheck; CI green

## 9. Live migration (maintainer present, explicit OK per step)

- [ ] 9.1 `task backup:verify` + manual snapshot
- [ ] 9.2 `task build`, then `scripts/migrate-tenancy.sh --dry-run`; review the plan together
- [ ] 9.3 Real run (maintainer OK), verification output reviewed
- [ ] 9.4 Browser check: library, detail, Ask, upload of a new document (gets a home space before extraction)
