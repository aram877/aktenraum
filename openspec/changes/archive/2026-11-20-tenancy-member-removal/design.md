# Design

## Context

- Tenancy state lives in aktenraum's database (`members`, `spaces`, `space_members`, `document_spaces`, `document_shares`, `share_audit`). Paperless permissions and the Qdrant payload (`space_id`, `shared_with`) are derived from it by `mirrorDocument`, `syncSpaceMembership` / `removeFromSpaceGroups` and `vectorStore.setSpaceByDocId`.
- Moves and shares follow "DB → Paperless → Qdrant, undo on failure" for one document at a time. A removal touches every document of a member (a few hundred on a real install), so per-request compensation does not fit: undoing 200 moves because document 201 failed is worse than finishing it.
- `reconcileTenancy` creates a member for every `users` row that has none and repairs personal-space owners. Deleting a member row would bring it back on the next start, and `granted_by`, `invites.created_by_member_id` and `share_audit` refer to member ids.
- `applySchema` only runs `CREATE TABLE IF NOT EXISTS`, so new state goes into new tables.
- Paperless 2.20 hides soft-deleted documents from `/api/documents/{id}/`, so `mirrorDocument` cannot reach a trashed document (`PaperlessNotFoundError`). The member trash list and restore go through the member's own token, so a trashed document still owned by the removed member's Paperless user would be invisible to the successor.
- DRF token auth rejects tokens of inactive users, so `is_active: false` is enough to kill a Paperless token.

## Goals / Non-Goals

**Goals:**
- Lock the member out before any long-running work starts, and keep them locked out whatever fails afterwards.
- Make every step idempotent and resumable, so a crash or Paperless outage only delays completion.
- Reuse the existing mirror / group / Qdrant helpers. No second permission model.

**Non-Goals:**
- Undoing a removal halfway through. Once accepted it only moves forward.
- Batching Paperless writes (one PATCH per document, like the tenancy migration).

## Decisions

### 1. Soft removal in a new `member_removals` table

```
member_removals(
  member_id     PK → members.id,
  successor_id  → members.id,
  removed_by    → members.id,
  removed_at    timestamptz default now(),
  phase         'db' | 'derived' | 'done',
  attempts      int default 0,
  last_error    text null,
  completed_at  timestamptz null
)
member_removal_documents(
  member_id → member_removals.member_id,
  paperless_doc_id int,
  synced_at timestamptz null,
  PK (member_id, paperless_doc_id)
)
```

The member, user, personal space and its owner row stay, so reconcile has nothing to "repair" and all references stay valid. "Removed" means "has a `member_removals` row". Every member-facing lookup filters on that: `TenancyService.findMember` (returns `null` → `AuthGuard` 401), `HouseholdService.listMembers` / `directory`, `SpacesService.householdMember`, `SharesService.assertHouseholdMember`, `useSpacesVisible`'s member count.
*Alternative*: a `removed_at` column on `members`. Rejected, `applySchema` can't add it. *Alternative*: hard delete. Rejected for the reconcile and FK reasons above.

### 2. A three-phase, resumable removal

`POST /api/household/members/:id/remove` body `{ confirm_username, successor_member_id? }`:

1. **Validate** (spec: admin only, not admin/self, confirmation, successor). Insert the `member_removals` row with `phase='db'`. **This insert is the lockout.** From here on `findMember` returns `null` for the member and login fails. Then `MemberGateways.forget(member)` and delete `member_paperless_tokens` for the member.
2. **Phase `db`**, each statement idempotent:
   - record affected documents in `member_removal_documents` (`ON CONFLICT DO NOTHING`): the member's personal-space documents, documents in shared spaces they own, and documents with a share received by the member;
   - `document_spaces` of the personal space → successor's personal space;
   - for each shared space they own: delete the successor's existing editor/viewer row, set the owner row's `member_id` to the successor;
   - delete their editor/viewer rows in other shared spaces;
   - delete shares they received, and shares whose recipient is now in the document's home space (the successor). Audit `revoked`, actor = admin;
   - set `phase='derived'`.
3. **Phase `derived`** (Paperless + Qdrant), each step idempotent:
   - Paperless user of the member: `updateUser(id, { is_active: false, groups: [] })`. This one PATCH also does every `removeFromSpaceGroups`;
   - `syncSpaceMembership` for every shared space whose owner changed (puts the successor into the writer group, out of the viewer group) and for the successor's personal space;
   - per affected document not yet `synced_at`: `mirrorDocument` (trash handling in §4), then `setSpaceByDocId(doc, qdrantSpaceFor(doc))`, then set `synced_at`;
   - `MemberGateways.forget(successor)`. Set `phase='done'`, `completed_at`.

The request runs phases 2 and 3 inline. A failure in phase 3 (or 2) is caught, stored in `last_error`/`attempts`, logged (`member_removal_incomplete`), and the request still answers 200 with `status: "completing"`. Validation errors answer before step 1, so they change nothing.
*Alternative*: one DB transaction for phases 1–2. The repo has no drizzle transactions yet and pg-mem's support is untested. The phase field gives the same crash safety and also covers phase 3, which a transaction can't.

### 3. Removal sync

`MemberRemovalService` (in `household/`) re-runs phases 2–3 for every row with `phase <> 'done'`: once in `onApplicationBootstrap` and every 5 minutes (unref'd timer, same pattern as the share expiry sweep). A per-member in-process lock stops the sync and a request from running the same removal at once. Back-off: none beyond the 5-minute cadence. `attempts` is only for display and logs.

### 4. Trashed documents

When `mirrorDocument` raises `PaperlessNotFoundError` for an affected document, the sync checks the trash with the service gateway. If the document is there: `restoreDocuments([id])` → `mirrorDocument` → `deleteDocument(id)` (back to the trash), all with the service gateway. Then the successor sees it in `/trash` and can restore it. A document in neither place (hard-deleted meanwhile) counts as synced, and its `document_spaces` row is dropped like `TrashService.forgetHomeSpaces` does. Qdrant: `setSpaceByDocId` is a no-op for a document without chunks.
Side effect: the trash timestamp resets, so the 30-day auto-purge restarts for those documents. That is accepted and documented.
*Alternative*: leave trashed documents stale and re-mirror on restore. Rejected: the successor's token can't see them in the trash to restore them in the first place.

### 5. Login and sessions

- `AuthGuard` already resolves the member through `TenancyService.resolveMember`. A removed member makes `findMember` return `null`. `resolveMember` then runs reconcile, which creates nothing (the member row exists), and returns `null` → 401. To keep that cheap, `findMember` returns a `removed` marker and `resolveMember` skips the reconcile for it.
- `AuthService.login` checks removal **after** the bcrypt compare and answers the same 401 as a wrong password, so neither timing nor answer tells whether the username was removed. Removed attempts count towards the login throttle like failures.

### 6. Uploads in flight

`HomeSpaceService.personalSpaceOf(memberId)` follows `member_removals.successor_id` (chains too: if the successor was removed later, follow until a current member, max depth 10, else the admin's space). `uploadTarget` already falls back to the personal space when the uploader can no longer place into the requested space. Since the removed member holds no space roles beyond their personal space, that fallback now lands at the successor.

### 7. Preview

`GET /api/household/members/:id/removal-preview?successor=<id>` runs the phase-2 queries read-only: `{ documents: n, trashed: n, spaces_owned: [{id, name}], spaces_left: [{id, name}], shares_revoked: n, shares_kept: n }`. Same validation as the removal minus the confirmation.

### 8. API surface

| Route | Scope | Answer |
| --- | --- | --- |
| `GET /api/household/members/:id/removal-preview?successor=` | `household:admin` | preview §7 |
| `POST /api/household/members/:id/remove` | `household:admin` | `{member_id, successor_member_id, status: "done" \| "completing"}` |
| `GET /api/household/removals` | `household:admin` | `[{member_id, username, successor, removed_at, status, last_error}]` |

All three go into the route inventory. Errors use the `{detail}` shape: 403 scope, 404 unknown/removed, 409 admin/self, 422 confirmation/successor.

### 9. SPA

`Mitglieder.vue`: per non-admin member an "Entfernen" button opens a dialog. It has a successor select (default: me), the preview text ("30 Dokumente gehen an A, A wird Eigentümer von „Wohnung“, 2 Freigaben enden…"), a username input, and a confirm button disabled until the username matches. Below the member list, an "Entfernte Mitglieder" list from `/removals`, with an amber "wird abgeschlossen" pill while `status ≠ done` (polled every 10 s while any is incomplete). On success, invalidate `household`, `spaces`, `shares` and `library` queries.

## Risks / Trade-offs

- [The successor gets aktenraum access before Paperless permissions follow; their own-token reads 404 until mirrored] → phase 3 runs inline, so on a healthy stack the window is the length of the request. The member list shows "wird abgeschlossen" until done.
- [A large personal space makes the request slow (one Paperless PATCH per document, ~50–100 ms)] → 300 documents ≈ 30 s, inside nginx's 300 s `proxy_read_timeout`. A timeout only cuts the response; the sync finishes the work.
- [Re-trashing resets the trash auto-purge clock] → accepted, documented in CLAUDE.md gotchas.
- [Shares the member granted stay active under the successor without the successor having chosen them] → they appear in the successor's "Von mir geteilt" and the removal preview counts them ("2 Freigaben bleiben bestehen"), so the admin and successor know.
- [Chained successors (A removed with successor B, B later removed)] → B's removal moves everything B holds, including what came from A. Upload fallback follows the chain (§6).
- [Lockout depends on every member lookup filtering removals] → one place (`findMember`) for auth. A route test sends a removed member's cookie to one route per controller, as in the route inventory.

## Migration Plan

- Deploy: `applySchema` creates the two tables. No data changes. The live household has one member (the admin), and the remove button is never shown for the admin, so nothing is visible until a second member joins.
- Rehearse on the e2e stack (three members, shares, a shared space, a trashed document, Paperless stopped mid-removal), see tasks.
- Rollback: reverting the code leaves the removed member unlocked (no lookup filters `member_removals` any more) while their documents already belong to the successor. Before rolling back, also disable the member's user. Documented in ADR-009's "as built" note.

## Open Questions

- Whether ADR-010 step 4 should replace the typed-username confirmation with a step-up passkey assertion. Deferred to that change; the route stays the same.
