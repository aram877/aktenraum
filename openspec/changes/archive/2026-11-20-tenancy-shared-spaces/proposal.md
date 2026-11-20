# Proposal

## Why

ADR-009 part 2, second of three changes (`tenancy-members` → `tenancy-shared-spaces` → `tenancy-document-shares`). Since `tenancy-members` a household can have several members, but every document still lives in its owner's personal space. Anything managed together long-term (joint account, mortgage, house, insurance) has no shared home. That is ADR-009's rule of thumb: "something managed together long-term goes into a shared space".

## What Changes

- **Shared spaces ("Akten")**: any member can create a shared space, rename it and delete it once it is empty. The creator is its **single owner** (maintainer decision 2026-11-19): only the owner manages members and roles, deletes documents in it and moves documents out of it. Handing ownership to someone else is deferred.
- **Space membership**: the owner adds household members as `editor` (read, correct AI fields, approve or reject, upload into it, move documents into it) or `viewer` (read, download, ask the AI), changes their role and removes them. Non-owners can leave a space. Personal spaces keep exactly one member.
- **Paperless mirror for shared spaces**: each shared space gets a writer group (`space-<id>`, view + change) and a viewer group (`space-<id>-view`, view only). Membership changes only edit group membership, so no document is rewritten when someone joins or leaves. A document's Paperless owner is the space owner, as it already is for personal spaces.
- **Moving documents** between spaces: "Verschieben" on the document detail pages, and bulk move from the library's multi-select. This needs `owner` on the source space and `owner` or `editor` on the target. A move rewrites `document_spaces`, the Paperless owner and permissions, and the Qdrant `space_id` payload (no re-embedding). If any step fails, the move is undone.
- **Upload into a space**: `/upload` gets a space picker. It defaults to the personal space and lists the spaces where the member is `owner` or `editor`. The worker's home-space assignment uses the chosen space.
- **Library**: every row shows its space, there is a `?space=` filter, and both detail pages offer "Verschieben".
- **Review inbox**: lists only documents of spaces where the member is `owner` or `editor` (ADR-009). Viewers see pending documents in the library, read-only.
- **`/akten` page**: my spaces with my role, the documents in each, create, rename, delete, members and roles, leave. A household directory (member id + username, readable by every member) feeds the member picker.
- **Hidden for a household of one**: the nav entry, space column, space filter, upload picker and "Verschieben" only appear once the household has a second member (ADR-009: "the UI hides spaces … until a second member exists").

## Non-goals

- Several owners per space, transferring ownership, deleting a non-empty space.
- Per-document shares, "Mit mir geteilt", audit log (`tenancy-document-shares`).
- The AI suggesting a target space; mail / consume-folder imports into a chosen space (they keep landing in the household admin's personal space).
- Per-space settings (auto-approve rules stay household-wide).
- Member removal from the household.

## Capabilities

### New Capabilities
- `shared-spaces`: creating, renaming and deleting shared spaces, their single owner, membership and roles, leaving, and how Paperless enforces it.
- `document-home-space`: choosing a document's space at upload, moving documents between spaces (single and bulk), and how the space shows up in the library, the inbox and the detail pages.

### Modified Capabilities
<!-- none: main specs are not kept in this repo; requirements are written as ADDED -->

## Impact

- **API**: new `spaces/` module (CRUD, membership, move, bulk move, directory), new scope `spaces:manage`, `DocumentAction` `move`, `PolicyService` unchanged in shape. `paperless-mirror.ts` gets a viewer group, plus membership sync and removal. `HomeSpaceService` honours an upload's chosen space via the new `upload_task_spaces` table. Library: space column + filter. Inbox: viewer filter. Upload: `space_id`. Qdrant `setSpaceByDocId` is called from the api.
- **Worker**: none. The metadata refresh already re-reads the space, and the api writes Qdrant directly on a move.
- **Web**: `/akten` page, nav entry, upload picker, library space column / filter / bulk move, "Verschieben" on both detail pages, `useSpaces` composable.
- **Live data**: no migration. Personal spaces and their documents keep their current Paperless permissions, and nothing is written until someone creates a shared space.
- **Docs**: ADR-009 "as built" note, CLAUDE.md, api-reference, session note.
