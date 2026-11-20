# Proposal

## Why

ADR-009 part 2 is complete: a household can invite members, run shared spaces and share single documents, but it cannot let anyone go. Today a member who moves out keeps their login, their Paperless user and every share they received, and the only remedy is psql. ADR-009 already names what a removal must do: "transfer of their personal space, removal from shared spaces without orphaning them, revocation of their shares."

## What Changes

- **Remove a member** (household admin only, from `/settings → Mitglieder`): the admin picks a **successor** among the remaining members (default: the admin themselves) and confirms by typing the member's username. The household admin cannot be removed, and nobody removes themselves.
- **Access ends first, and at once**: the member is marked removed before anything else moves. From that moment their sessions are rejected (401), login fails like a wrong password, their stored Paperless token is deleted and their Paperless user is deactivated and taken out of every group.
- **Their documents go to the successor, nothing is orphaned**:
  - every document whose home space is the member's personal space, trashed ones included, moves to the successor's personal space;
  - every shared space the member owns gets the successor as its new single owner (a successor who was an editor or viewer there is promoted);
  - the member leaves every other shared space they were an editor or viewer in.
- **Shares**:
  - every share the member **received** is revoked (`share_audit` event `revoked`, actor = the admin);
  - shares the member **granted** on documents that now belong to the successor stay, because the successor is now the home-space owner and can revoke them. A share whose recipient *is* the successor is dropped, since the space role now covers it.
- **Paperless and Ask follow**: every affected document is re-mirrored (owner, group and share-user permissions) and its Qdrant payload (`space_id`, `shared_with`) is rewritten. This runs right after the database change. Whatever fails is retried by a resumable sync until done, and the removal shows "wird abgeschlossen" until then.
- **Uploads still running** for the removed member land in the successor's personal space.
- **Irreversible by design**: the member row, its username and its audit history stay (shares' `granted_by`, `share_audit`, invites refer to it), but there is no "restore". Re-joining means a new invite and a new username.
- **SPA**: "Entfernen" per member in `/settings → Mitglieder` with a confirm dialog (successor picker, consequences summary with document / space / share counts, type-the-username), removed members disappear from the member list, directory and share pickers.

## Non-goals

- Exporting the member's documents before removal (ADR-009 mentions it; deferred, the successor can download).
- Handing over shared-space ownership outside a removal, or several owners (ADR-009 decision stays).
- Reactivating a removed member.
- Removing or demoting the household admin, or transferring the admin role.
- Deleting the member's Paperless user or the documents they uploaded.
- Step-up re-authentication for the action (ADR-010 step 4; the typed-username confirm is the interim guard).

## Capabilities

### New Capabilities
- `household-member-removal`: who may remove whom, the successor, how access ends, what happens to the member's personal space, shared spaces, received and granted shares and running uploads, how Paperless and Ask are brought in line, and how an interrupted removal completes.

### Modified Capabilities
<!-- none: main specs are not kept in this repo; requirements are written as ADDED -->

## Impact

- **API**:
  - `HouseholdService.removeMember` + `POST /api/household/members/:id/remove` (scope `household:admin`) and a dry-run `GET /api/household/members/:id/removal-preview` for the dialog's counts.
  - New table `member_removals` (member, successor, removed by, removed at, sync state). A new table because `applySchema` can't add a column to `members`.
  - `AuthGuard` / `AuthService.login` reject removed members. `TenancyService` member lists, `directory`, the share grant check and `SpacesService.householdMember` skip them.
  - `HomeSpaceService` sends a removed uploader's documents to the successor's personal space.
  - Paperless gateway: deactivate a user (`is_active: false`, `groups: []`).
  - A removal sync (startup + periodic) finishes removals whose derived state is incomplete.
- **Worker**: none. It reads the home space from the api when indexing.
- **Web**: remove dialog in `components/settings/Mitglieder.vue`, `useHousehold` mutation + preview query, a "wird abgeschlossen" state.
- **Live data**: no migration. The live household has no member to remove; the table is created by `applySchema`.
- **Docs**: ADR-009 "as built" note for removal, CLAUDE.md, api-reference, session note.
