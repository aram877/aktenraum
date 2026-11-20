# ADR-009: Tenancy — households, members, spaces and per-document shares

**Status**: Accepted (Paperless mapping confirmed by spike on 2026-11-19, see "Spike results")

**Date**: 2026-11-19

**Related**: [ADR-002](002-distribution-desktop-app.md) (desktop distribution), [ADR-003](003-csrf-defence.md) (CSRF), [ADR-005](005-test-phase-access-via-tailscale.md) (remote access). Precedes the planned auth-layer ADR (passkeys, server-side sessions, scopes, per-service credentials).

## Context

aktenraum is single-user by construction. A read-only audit on 2026-11-19 found:

- **Database** (`services/aktenraum-api/src/db/schema.sql`): only `users` knows about users. `app_settings` is one global row, `auto_approve_rules` is keyed by `document_type` only (`updated_by` is free text), `document_type_fields` and `upload_tasks` carry no owner.
- **Paperless**: every call uses one `PAPERLESS_API_TOKEN` (admin), regardless of which aktenraum user is asking.
- **Qdrant**: the chunk payload (`packages/aktenraum-core/src/rag/vectorStore.ts`) has no owner field, so RAG would return every user's documents to every user.
- **AI pipeline**: few-shot exemplars, the per-correspondent history hint and the duplicate detector read the whole propagated corpus.
- **Ingest**: upload-source detection treats "ownerless Paperless task" as the consume folder (`ingest.service.ts`), which breaks as soon as documents have owners.
- **SSE live counts** (`events.controller.ts`) are deliberately unscoped.
- **Bootstrap** creates exactly one user from `docker/.env`.

The product must serve two shapes with one code path: a **single person**, and a **family/household** that shares some matters (joint bank account, mortgage, house, insurance) while keeping others private (payslips, medical, personal contracts). Within the private part, members need to grant each other access to individual documents — e.g. sharing the car-loan contract permanently, or three payslips for a loan application for a limited time — without giving up ownership.

The planned cloud storage / cloud analysis feature (later) needs the tenancy model to map onto an encryption key hierarchy, so the model has to be decided before the auth layer is rebuilt.

## Decision

We will model tenancy as **Household → Members → Spaces**, with **one home space per document** plus optional **per-document shares**, and route every access decision through **one policy service**.

### Entities

- **Household** — one per install. It is the tenant boundary; `household_id` is put on every tenant-scoped table now, even though one install hosts one household, so cloud multi-tenancy later is an additive change.
- **Member** — a person in the household. Household role: `admin` (members, LLM settings, backups, auto-approve rules) or `member`.
- **Space** ("Akte") — a container of documents with its own member list. Space role: `owner`, `editor`, `viewer`. Every member gets a personal space on creation; shared spaces (e.g. "Haushalt", "Haus & Kredit") are created by members and joined by invitation.
- **Home space** — every document belongs to **exactly one** space. Moving a document between spaces is an explicit owner action.
- **Share** — an explicit grant on one document: `{document, member, role: viewer | editor, expires_at?, granted_by, granted_at}`.

A single user is a household of one member with one personal space; the UI hides spaces and sharing until a second member exists. There is no "single-user mode".

Rule of thumb for users: **something managed together long-term goes into a shared space; an exception goes into a share.**

### Share semantics

- `viewer`: see, download, ask the AI about it. `editor`: additionally correct AI fields. Neither may delete, move or re-share — those stay with the home-space owner(s).
- The recipient sees shared documents under "Mit mir geteilt", labelled with who shared them. The owner sees a list of everything they have shared and can revoke any share.
- Optional expiry. Checked on every request (exact) and swept periodically (cleanup of derived state, e.g. Qdrant payload).
- **Shares are explicit, never rule-based.** "Automatically share every Gehaltsabrechnung" would silently expose future documents. Dynamic sharing, if ever wanted, is a separate decision with an explicit warning.
- Every grant, revoke and access to a shared document is written to an audit log visible to the owner.

### Access policy

`canRead(member, doc) = member ∈ members(doc.home_space) OR active share(doc, member)`; `canEdit`, `canDelete`, `canMove`, `canShare` follow the role tables above. This lives in one `PolicyService` in aktenraum-api. Controllers and services ask it; none implements its own check.

### Scoping rules beyond the UI

- **RAG**: each Qdrant chunk payload carries `space_id` and `shared_with: [member_id]`; every search filters on `space_id ∈ my spaces OR my id ∈ shared_with`. Sharing/revoking/moving updates the payload through the existing metadata-only path (`updateMetadataByDocId`, today used by star/unstar). No re-embedding needed.
- **AI pipeline is scoped to the home space only**: few-shot exemplars, the correspondent history hint and duplicate detection read only documents from the same home space. A shared document never feeds the recipient's prompts. Without this rule private content leaks through prompts, not through the UI.
- **Live counts / activity / library / inbox** are computed per member over the documents they can read. The review inbox shows documents of spaces where the member is `owner` or `editor`.

### Ingest

- Upload: the user picks a space; default is their personal space.
- E-mail: one mailbox/rule per member, landing in that member's personal space.
- Consume folder: one subfolder per space.
- The AI may *suggest* a different space ("looks like a joint-account statement → Haushalt"); it never moves a document across spaces by itself.
- Upload-source detection stops relying on "ownerless task"; aktenraum records the source explicitly.

### Settings split

- Household: LLM models, backup, auto-approve rules (for now).
- Member: UI preferences, passkeys, sessions/devices.
- Space: reserved; nothing yet.

### Paperless mapping (confirmed by spike)

**Paperless enforces too** — one Paperless user per member, one Paperless group per space, document owner + group permissions for the home space and per-user permissions for shares. The api calls Paperless with the member's token for user requests; the worker keeps a service token. aktenraum's `PolicyService` remains the primary decision point; Paperless permissions are the second layer and keep Paperless's own admin UI consistent.

Mapping:

| aktenraum | Paperless |
| --- | --- |
| Member | non-superuser user with model permissions (`view/add/change/delete_document`, `view/add_tag`, `view/add_correspondent`, `view/add_documenttype`, `view_customfield`, notes, `view_paperlesstask`, ui settings) |
| Space | group `space-<slug>` |
| Home space | document `owner` = creating member + `set_permissions` view+change for the space group (`owner`/`editor` roles) or view only (`viewer` role, enforced via per-user perms) |
| Share (viewer) | `set_permissions.view.users += member` |
| Share (editor) | `set_permissions.view.users` and `change.users += member` |
| Delete / move / re-share | owner only — Paperless already denies these to non-owners |

### Metadata ownership (shared vocabulary)

Paperless makes every tag, document type and correspondent **owned by whoever created it and invisible to all other users** — including on documents those users are allowed to read (they get the raw id and a 404 on resolve). Member-created metadata is likewise private to its creator, which would fork the vocabulary ("Kfz" created twice).

We will therefore keep **one shared, household-wide vocabulary**: tags, document types and correspondents are stored with `owner = null`. The worker, `scripts/bootstrap-paperless.sh` and every aktenraum code path that creates metadata must set `owner: null` explicitly. Custom fields have no ownership and are already visible to everyone.

Privacy trade-off, accepted: members can see the **names** of all tags, types and correspondents in the household (e.g. a correspondent "Psychotherapiepraxis Dr. X"), but not which documents carry them — Paperless scopes `document_count` per user (verified). Per-space metadata (fully private names, duplicated entities, more complex propagation) is the alternative if this proves insufficient.

### Encryption mapping (for the later cloud feature, not built now)

Envelope encryption: each document has its own data key, wrapped by its space key; each space key is wrapped once per **passkey** of every space member (a PRF-derived key — the PRF output differs per passkey, verified in the ADR-010 spike) plus once per member recovery key. A share wraps the document key for the recipient. Limitation stated in the UI: under end-to-end encryption revoking stops future access but cannot recall copies already downloaded.

### Out of scope

- Several households per install (SaaS multi-tenancy). `household_id` keeps the door open.
- Rule-based/dynamic sharing.
- Emergency access (trusted member gains access to a personal space after a waiting period) — a strong family feature, separate decision.

## Consequences

**Easier**

- One code path for single user and family; no mode switch.
- Access is reasoned about in one place (`PolicyService`) and tested as a matrix.
- The shared/private split matches how households think about their paperwork, and per-document shares cover the exceptions without moving ownership.
- RAG isolation is one payload filter, reusing the existing metadata-refresh path.
- The model maps directly onto per-space and per-document keys for the cloud feature.

**Harder**

- Every existing query (library, inbox, activity, live counts, Ask, duplicates, few-shot, history hint) must become member-scoped; a missed one is a privacy bug. This needs a dedicated test matrix (member × space role × share × expiry).
- Per-member Paperless users and tokens have to be provisioned, stored and rotated.
- Qdrant payload migration for existing chunks (`space_id`, `shared_with`) — metadata-only, no re-embed.
- Upload-source detection in `ingest.service.ts` must be rewritten.
- Member removal needs a defined flow: export or transfer of their personal space, removal from shared spaces without orphaning them, revocation of their shares.
- Shares with expiry introduce time-based state that must be swept from derived stores.

### Migration (existing installs)

State of the maintainer's install on 2026-11-19 (read-only check): 498 tags, 22 document types and 85 correspondents, all owned by the Paperless admin (user 3); 257 documents, 195 owned by the admin and **62 ownerless** (consume folder / e-mail — ownerless documents are visible to every Paperless user); one Paperless user (superuser).

1. Create the household, convert the existing user into its `admin` member with a personal space; create the matching Paperless user and group.
2. Set `owner = null` on every tag, document type and correspondent (shared vocabulary).
3. Assign every existing document — including the ownerless ones — to that personal space: set `owner` to the member's Paperless user and apply the space group permissions. The user can move documents to shared spaces afterwards.
4. Backfill the Qdrant payload (`space_id`, empty `shared_with`) via the metadata-only update.
5. Switch the worker and the bootstrap script to create metadata with `owner: null`, and new documents with the target member as owner.

#### As built (`tenancy-foundation`) and rehearsed — live run pending

The migration is a CLI, `bash scripts/migrate-tenancy.sh [--dry-run]` (→ `node dist/tenancy/migrate.js` in the api container). Seven ordered, idempotent steps, each logged as a JSON event: (1) household / admin member / personal space (`reconcileTenancy`, the same code the api runs at startup), (2) Paperless user `ak-<members.id>` (non-superuser, the spike's permission set, random unstored password) and group `space-<spaces.id>`, (3) `owner = null` on every tag, correspondent and document type, (4) a `document_spaces` row for every Paperless document → the admin's personal space, (5) owner + view/change for the space group via `bulk_edit` → `set_permissions` (per-document fallback), (6) Qdrant `space_id` backfill via `set_payload` (no re-embed), (7) verification: documents without home space, permission drift, owned vocabulary, and a document count through each member's own Paperless user. A real run refuses unless the backup status is healthy and the newest complete snapshot is < 2 h old (`--i-have-a-backup` overrides).

Steps 5's "new documents with the target member as owner" is done by the worker, not at upload: before extraction it calls `POST /api/tenancy/assign-home-space`, which picks the uploader's personal space (aktenraum uploads, recorded in `upload_task_members`) or the household admin's (mail, consume folder) and mirrors it into Paperless.

Rehearsal on the e2e stack (2026-11-19, Paperless 2.20.15): worker e2e 20/20 on the new code; seeded pre-tenancy shape (210 tags, owned + ownerless documents) → dry run matched the plan and wrote nothing, a run without a backup was refused, the real run verified 6/6 through `ak-1`'s own token, a re-run had nothing to do; the permission spikes gave the same results as before. Observed on the real API: a POST without `owner` makes the caller the owner, a POST with `owner: null` keeps it null; `full_perms` + `fields` and `bulk_edit` with `owner` both work.

#### As built (`tenancy-shared-spaces`, 2026-11-19) — live deploy pending

- **Single owner per shared space** (maintainer decision): the creator is the one `owner` row, never added or removed through the API; handing ownership over and several owners are deferred. Only the owner manages members, deletes documents and moves them out. A shared space is deleted only when no `document_spaces` row points at it (trashed documents keep theirs; a hard delete drops it).
- **Two Paperless groups per shared space**: writer `space-<id>` (owner + editors, view + change) and viewer `space-<id>-view` (viewers, view only; id in `space_paperless_groups`). Shared documents get `view = [writer, viewer]`, `change = [writer]`, owner = the space owner. Membership changes only edit users' `groups` (`syncSpaceMembership` / `removeFromSpaceGroups`), so no document is rewritten and revocation is immediate. Personal spaces keep the one-group target, so nothing on an existing install changes at deploy.
- **Moves** (`owner` of the source, `owner`/`editor` of the target): conditional `document_spaces` update → mirror with the service gateway → Qdrant `setSpaceByDocId`, undone on failure (502); the worker's startup reconcile re-sets chunk spaces that disagree with `document_spaces` in case the undo failed too.
- **Upload picker**: `space_id` is checked before upload, recorded in `upload_task_spaces` and used by the home-space assignment while the uploader is still owner/editor there (else personal space). Mail and consume-folder imports still land in the household admin's personal space.
- **Review inbox** skips documents of spaces where the member is only a viewer.
- **`id__in`** (library `?space=`): measured on Paperless 2.20.15 — 8,000 ids (~56k chars) fine, 16,000 (~112k chars) → 414. The api sends up to 1,000 ids per request and chunks above that.
- The SPA shows every space feature (nav "Akten", upload picker, library column/filter/bulk move, "Verschieben") only once `household_member_count ≥ 2`.
- Rehearsed on the e2e stack (Paperless 2.20.15): worker e2e 20/20; shared-space flow 29/29 (invite, viewer can't upload, upload into the space, viewer reads through their own token but can't edit, inbox excludes it, Paperless permissions, move in/out, editor edits but can't delete, removal → 404, delete only when empty).

#### As built (`tenancy-document-shares`, 2026-11-20) — live since 2026-11-20, e2e rehearsal pending

- **Tables**: `document_shares` (one row per document + member, role `viewer`/`editor`, optional `expires_at`, `granted_by`; a revoke deletes the row) and `share_audit` (granted, role_changed, expiry_changed, revoked, expired, accessed + access kind). "Active" is always decided in SQL (`expires_at IS NULL OR expires_at > now()`), never by comparing with `Date.now()`.
- **Who shares**: only the owner of the document's home space (`DocumentAction` `share`). Refused: self (422), unknown member (422), a member of the home space (409), a second share for the same member (409, change it instead), a past expiry (422). Recipients never re-share.
- **Roles**: share `viewer` = read; share `editor` = read + `edit-fields` (AI fields and type fields). A new action `edit-fields` (space editor/owner, share editor, the worker) replaced `write` on `PATCH /fields` and `PATCH /type-fields`; approve, reject, inbox PATCH, reprocess, star and dismiss-duplicate stay on `write`, which no share holds. A space role always wins over a share. Detail payloads expose `access: {via: space|share|admin, role}` so the SPA hides refused actions.
- **Paperless**: `mirrorDocument` adds active recipients as `view.users`, editors also as `change.users` (sorted). No shares = the exact space target, so the deploy mirrors nothing. Grant/change/revoke run DB → Paperless (service gateway) → Qdrant `shared_with`, undone with 502 on failure; moves keep `shared_with` (they used to reset it to `[]`). A hard delete in the trash drops the document's shares.
- **Expiry**: policy ends access at the instant. `SharesService.expireDue` re-mirrors and re-sets `shared_with` first and only then deletes the row and audits `expired` (a failure keeps the row for the next run); it runs every 5 minutes and, scoped to the caller, at the start of the library list, `/shares/with-me`, the inbox list, live counts and Ask.
- **Recipient view**: library rows and detail payloads carry `home_space: null` + `shared_by: {username, role, expires_at}` when the caller reaches the document only through a share — the sharer's space name never leaves the server. `?space=` still covers only the caller's spaces. Shared documents never enter the recipient's review inbox or inbox count. Few-shot, history hint and duplicates stay keyed on the home space (regression-tested on both sides).
- **Audit**: access by a recipient is recorded from the route decorator `@ShareAccessKind` (detail, preview, download — on `/documents` and `/inbox`) and for Ask citations (`ask`), at most once per document, member and kind per hour, best effort. Only the home-space owner reads it (`GET /documents/:id/shares/audit`, newest first, ≤ 500).
- **Rollback**: reverting the code leaves the tables unused but Paperless still grants recipients until a re-mirror; run the tenancy migration's verify step (its target has no user grants) to find and drop them.


Run against the throwaway e2e Paperless (2.20.15, project `aktenraum-e2e`), never the live stack. Scripts: `scripts/spikes/paperless-perm-spike.mjs` (38 checks) and `scripts/spikes/paperless-perm-spike-2.mjs` (metadata/count/task follow-up). Re-run after every Paperless upgrade.

Setup: alice owns A (private), H (group `space-haushalt` = alice + bob, view+change) and S (shared to bob, view only); carol has no access.

- **List isolation holds** for bob: list and pagination `count`, `?query=` full text, `content__icontains`, `tags__id__in/none`, `document_type__id`, `id__in`, `more_like_id`, global `/api/search/`, `/api/search/autocomplete/`, `/api/statistics/` — none expose A.
- **Direct access to A is denied**: detail 404; preview, download, thumb, metadata, notes, suggestions, history 403.
- **Write rules**: viewer cannot PATCH; group change can PATCH; non-owner cannot change permissions, take ownership or DELETE (403); `bulk_edit` (incl. `set_permissions`) respects object permissions.
- **Revocation is immediate**: removing a share or a group membership removes the document from detail and full-text results at once.
- **Trash** lists only the user's own documents; a non-owner cannot restore. **Tasks** (`/api/tasks/`) are scoped to the uploading user.
- **Service token** (superuser) sees everything — what the worker needs.
- **Metadata trap** (2 failing checks, see "Metadata ownership"): admin- or member-created tags/types/correspondents are invisible to other users. With `owner = null` they resolve for everyone and `document_count` stays per-user (bob 1, alice 3).

### Open points

- Whether auto-approve rules should later move from household to space level.
- Audit-log retention period.
- Upload-source detection replacement (Paperless tasks are per-owner, so "ownerless task = consume folder" no longer holds once every document has an owner).
