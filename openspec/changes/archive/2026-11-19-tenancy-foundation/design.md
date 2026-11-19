## Context

ADR-009 decided Household → Members → Spaces with one home space per document, enforced by aktenraum's `PolicyService` and mirrored into Paperless permissions. The 2026-11-19 spike proved Paperless enforces per-user/group document permissions on every list, filter and search endpoint, and that creator-owned metadata is invisible to other users. Steps 1–2 of ADR-010 left one guard path (`authorize`) and a `PolicyService` that currently always allows members.

Live install (2026-11-19): one aktenraum user, one Paperless superuser (id 3), 257 documents (195 owned by user 3, 62 ownerless), 498 tags, 22 document types, 85 correspondents (all owned by user 3), Qdrant collection `aktenraum_chunks`.

## Goals / Non-Goals

**Goals:** the data model exists and holds the live install; every document has a home space in aktenraum and matching Paperless permissions; metadata is shared; RAG and the AI pipeline are space-aware; the migration is rehearsed, idempotent and gated on a fresh backup.

**Non-goals:** anything a second member would see (invites, shares, sharing UI, per-member Paperless tokens), passkeys.

## Decisions

**aktenraum's `document_spaces` is the source of truth; Paperless permissions are the mirror.** The policy, the Qdrant payload and the worker need the home space without a Paperless call, and Paperless has no notion of "home space" beyond owner + group permissions. A reconcile check compares both and reports drift.

**The api keeps using the service token for user requests in this change.** With one member, switching to per-member Paperless tokens changes nothing visible, but it would add token minting, encrypted storage and rotation to an already data-touching change. The Paperless users and groups are created now (so permissions can be set), and the token switch lands with the second member.

**One Paperless user per member, created by aktenraum.** It's non-superuser, with the permission set the spike used (`view/add/change/delete_document`, `view/add_tag`, `view/add_correspondent`, `view/add_documenttype`, `view_customfield`, notes, `view_paperlesstask`, ui settings). Username `ak-<members.id>`, random password never stored (aktenraum will mint tokens via the admin API later). The existing superuser stays as the service account.

**Home space assignment happens in the worker, before extraction.** Every document passes through the worker, whatever the source, so that's the one place that sees uploads, mail and folder imports alike. The worker asks the api (`POST /api/tenancy/assign-home-space`, `internal:tenancy-write`, a new worker scope) so the decision and the Paperless permission write live in one service. A document that already has a home space is skipped (idempotent, also on reprocess).

**Default space rule is deliberately simple.** Uploads: the member recorded in `upload_tasks` at upload time. Everything else: the household admin's personal space. Per-member mailboxes and per-space consume subfolders are second-half work.

**Metadata `owner = null` is part of the migration and of every create path.** That covers `PaperlessGateway.ensureTag` / entity creation, `PaperlessClient.getOrCreateNamed` (worker propagation), and `bootstrap-paperless.sh`. Without the create paths, every new tag would be invisible to future members again.

**Qdrant: payload fields + index, backfilled metadata-only.** `space_id` (keyword index) and `shared_with` (keyword array, empty for now). The indexer writes them; `updateMetadataByDocId` backfills existing chunks, the same mechanism star/unstar uses, so there's no re-embedding. Retrieval adds `space_id ∈ principal spaces OR principal member ∈ shared_with` to every search.

**The migration is a CLI, not startup code.** `node dist/tenancy/migrate.js [--dry-run]` in the api container, wrapped by `scripts/migrate-tenancy.sh`. Steps are ordered, each idempotent and logged, so a crash resumes:
1. reconcile household/member/personal space (same code as startup)
2. Paperless user + group for the member/space
3. metadata `owner = null` (tags, types, correspondents)
4. `document_spaces` rows for every document (all → admin's personal space)
5. Paperless `owner` + group permissions per document (bulk where Paperless allows, else per document with progress)
6. Qdrant payload backfill
7. verification: counts per step, a drift report (aktenraum vs Paperless), and a non-admin check reading the document list through the new Paperless user's token must return all 257

It **refuses to run** unless the newest restic snapshot of all three tags is younger than 2 h (reads the backup status file from `backup-status`), unless `--i-have-a-backup` is passed. It runs on the e2e stack first, with a seeded corpus that includes ownerless documents and >200 tags.

**Principal ids.** `MemberPrincipal.memberId` becomes `members.id`; `userId` (`users.id`) is added for the auth code that still needs it (change password). `householdId` is added. The JWT keeps carrying `users.id`; the guard resolves the member.

## Risks / Trade-offs

- **Partial migration** (crash between steps) leaves documents without Paperless permissions. Mitigation: resumable steps, a drift report, and the service token still sees everything, so nothing becomes unreachable.
- **Wrong Paperless permission set** could make documents invisible to the future member user. Mitigation: step 7 reads through that user's token before declaring success; the e2e rehearsal does the same.
- **Bulk permission writes** may be slow (257 PATCHes); acceptable as a one-off with progress output.
- **Ownerless documents (62)** become owned. That's intended (ADR-009), but it changes what a future non-admin Paperless user could see if added outside aktenraum. Documented in the runbook.
- **Rollback:** the restic snapshot from the gate. The aktenraum tables can be dropped; Paperless permission changes revert only via the snapshot, which is why the gate exists.

## Migration Plan

1. Implement + unit/route tests (pg-mem, fake Paperless with users/groups/permissions).
2. Rehearse on the e2e stack (`scripts/e2e-worker.sh` corpus plus extra ownerless docs and >200 tags): dry run, real run, re-run (no-op), verification.
3. Live: `task backup:verify`, manual snapshot, `scripts/migrate-tenancy.sh --dry-run`, review the plan with the maintainer, the real run with the maintainer's explicit OK, verification, browser check.
4. Deploy the worker/api changes that assign home spaces to new documents in the same release, so no document arrives without one.
