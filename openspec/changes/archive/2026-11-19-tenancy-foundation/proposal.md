## Why

ADR-010 step 3, first half of ADR-009. Steps 1 and 2 put every identity and access decision into guards, a `Principal` and a `PolicyService`, but the policy still says "every member may do everything" because there is no data model behind it: no household, no member record, no space, and no record of which space a document belongs to.

This change introduces that model with exactly **one household, one member (the existing user) and one personal space**, and moves the live install into it. Nothing becomes visible to anyone new. But every document gets a home space, Paperless itself enforces ownership, the RAG index knows each chunk's space, and the AI pipeline stops mixing spaces. The second half (more members, invites, shared spaces, shares, per-member Paperless tokens) then only adds rows and UI.

It is the first step that **writes to the live data**: all 257 documents (owner + permissions), all 605 tags/types/correspondents (`owner = null`) and every Qdrant chunk payload.

## What Changes

- **Schema** (new tables only; `applySchema` cannot alter tables): `households`, `members` (links `users`, household role, Paperless user id), `spaces` (personal/shared, Paperless group id), `space_members` (space role), `document_spaces` (Paperless doc id → home space; aktenraum's source of truth, mirrored to Paperless permissions).
- **Bootstrap/reconcile** at api start: ensure the household, a member for every `users` row (first user = `admin`), and one personal space per member, like the existing auto-approve-rule reconciler. Idempotent.
- **Paperless mapping** (ADR-009, spike-verified): one non-superuser Paperless user per member (created with the spike's permission set), one Paperless group per space. New and migrated documents get `owner` = the member's Paperless user and view+change for the space group.
- **Shared vocabulary**: tags, document types and correspondents get `owner = null`. The worker, the api and `scripts/bootstrap-paperless.sh` create new ones with `owner: null` explicitly.
- **Home space for new documents**: the worker assigns a home space when it first sees a document (before extraction) and applies the Paperless permissions. Rule for now: uploads → the uploader's personal space (recorded in `upload_tasks`), everything else (e-mail, consume folder) → the household admin's personal space. Per-member mailboxes and per-space folders come with the second half.
- **Principal and policy become real**: `MemberPrincipal` gains `householdId` and the `members.id` (separate from `users.id`). `PolicyService.canAccessDocument` checks the document's home space against the member's space memberships (still always true with one member, but now computed).
- **RAG**: the Qdrant payload gains `space_id` and `shared_with` (empty), with a payload index. The indexer writes them; retrieval filters on the caller's spaces. Existing chunks are backfilled through the metadata-only update (no re-embedding).
- **AI pipeline scoping**: few-shot exemplars, the correspondent history hint and duplicate detection only consider documents of the same home space.
- **Ingest source detection** no longer relies on "ownerless task = consume folder"; the source is recorded explicitly.
- **Migration tool** `tenancy-migrate` (api container, wrapped by `scripts/migrate-tenancy.sh`): `--dry-run` prints the plan, the real run is idempotent and resumable, and it refuses to run without a backup snapshot younger than 2 h. Rehearsed end to end on the throwaway e2e stack before it touches the live stack.

## Non-goals

- No second member, no invites, no shared spaces in the UI, no shares, no per-member Paperless tokens for user requests (second half: `tenancy-sharing`).
- No passkeys or sessions (ADR-010 step 4).
- No SPA changes beyond what keeps working unchanged; spaces stay hidden while a household has one member (ADR-009).

## Capabilities

### New Capabilities
- `tenancy`: households, members, spaces, document home spaces, Paperless ownership mapping, migration.

### Modified Capabilities
- `request-authorization`: the principal carries `householdId` and the member id; the policy decides from space membership.

## Impact

- **API**: `db/schema.ts` + `db/schema.sql` (5 tables), new `tenancy/` module (reconciler, space service, Paperless provisioning, migration CLI), `auth/` (principal fields), `policy/` (space-based decision), `ai/retrieval.ts` (space filter), `ingest/` (explicit source), `upload/` (records the uploading member), `paperless/paperless.gateway.ts` (users, groups, permissions, `owner: null` on create).
- **Worker**: home-space assignment before extraction, space-scoped few-shot/history/dedup, `space_id`/`shared_with` in the index payload, `owner: null` when creating entities (`@aktenraum/core` `PaperlessClient`).
- **Core**: `rag/vectorStore.ts` payload fields + index; `dedup.ts` space filter.
- **Scripts/compose**: `scripts/migrate-tenancy.sh`, `bootstrap-paperless.sh` (`owner: null`); e2e stack used for the rehearsal.
- **Docs**: ADR-009 migration section (actual steps), CLAUDE.md, upgrade runbook, session note.
