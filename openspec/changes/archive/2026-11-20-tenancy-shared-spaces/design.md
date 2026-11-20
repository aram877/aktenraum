## Context

After `tenancy-foundation` and `tenancy-members` (both archived 2026-11-19), the tables `spaces` (`personal` | `shared`), `space_members` (`owner` | `editor` | `viewer`) and `document_spaces` exist, and only personal spaces are ever created. `PolicyService` already decides by space role (`viewer` read, `editor` + write, `owner` + delete). Member requests reach Paperless with the member's own token (`MemberGateways.forPrincipal`). `paperless-mirror.ts` gives every space one group (`space-<id>`, view + change) holding its owners and editors, and sets each document's owner to the space's owning member. RAG retrieval filters by `space_id ∈ my spaces`. The worker's metadata refresh re-reads the space, and `QdrantVectorStore.setSpaceByDocId` exists (used by the migration). Few-shot exemplars, the history hint and duplicate detection are already scoped to the home space.

Maintainer decisions (2026-11-19): a single owner per shared space; a dedicated `/akten` page; single and bulk move; an upload picker.

## Goals / Non-Goals

**Goals:** members can manage documents together in shared spaces, with Paperless enforcing the same boundaries; moves are atomic across DB, Paperless and Qdrant; the live install sees no data change at deploy.

**Non-Goals:** see the proposal.

## Decisions

**1. One owner, stored as before.** The owner is the one `space_members` row with role `owner` (created with the space, never added or removed through the API). `spaceDocumentPermissions` already picks "the space's owner" as the Paperless owner, so Paperless's owner-only operations (delete, change permissions, trash restore) line up with aktenraum's `owner` role without the service token. *Alternative:* several owners with the service token doing deletes — rejected by the maintainer.

**2. Two Paperless groups per shared space.** Writer group `space-<id>` (owner + editors; view + change) and viewer group `space-<id>-view` (viewers; view only). Shared-space documents get `view.groups = [writer, viewer]`, `change.groups = [writer]`. Adding, removing or re-roling a member only edits that user's `groups`, so no document is rewritten and changes take effect at once (the spike showed immediate revocation). Personal spaces keep today's single-group target exactly, so `mirrorDocument` reports `unchanged` for every existing document and nothing on the live install is rewritten. The viewer group id has no column in `spaces` (`applySchema` can't add columns), so a new table `space_paperless_groups(space_id PK, viewer_group_id UNIQUE)` stores it. *Alternative:* per-user view permissions on every document — rewrites the whole space on each membership change; rejected.

**3. Membership sync is one idempotent function.** `syncSpaceMembership(db, paperless, spaceId)` provisions both groups, then for every member computes the target group set (writer for owner/editor, viewer for viewer) and PATCHes the Paperless user's `groups` only when they differ. A removed member is handled by `removeFromSpaceGroups(memberId, spaceId)`, which drops both group ids from their user. `provisionSpaceGroup` is reused for the writer group. After any membership change the affected member's gateway entity caches are dropped (`MemberGateways.forget`), so a stale tag/field map can't hide anything.

**4. `PolicyService` gains `move`, and roles gain `upload`/`move-in`.** `DocumentAction` adds `"move"` (owner only). Target-side checks ("may put documents into space S" = owner | editor) live in a new `SpacesService.canPlaceInto(memberId, spaceId)` because they are about a space, not a document. `@DocumentAccess` stays read/write/delete; the move routes call the policy explicitly per document (bulk needs per-document results anyway).

**5. Move = DB → Paperless → Qdrant, compensated on failure.** `SpacesService.moveDocument(principal, docId, targetSpaceId)`:
1. policy `move` on the doc + `canPlaceInto(target)`; same space → no-op 200;
2. `UPDATE document_spaces SET space_id = target WHERE paperless_doc_id = doc AND space_id = source` (conditional, so a concurrent move loses cleanly with 409);
3. `mirrorDocument` with the **service** gateway (the new owner may differ from the caller);
4. `vectorStore.setSpaceByDocId(doc, {spaceId: target, sharedWith: []})` when Qdrant is configured (a document with no chunks is a no-op);
5. on failure in 3 or 4: restore the row, re-mirror to the source (best effort, logged `space_move_compensation_failed` if that fails too), respond 502. Logged `document_moved {doc_id, from, to, member_id}`.
`shared_with` stays empty until `tenancy-document-shares`. Bulk move (`POST /api/spaces/:id/documents {doc_ids ≤ 200}`) runs the same steps sequentially and returns `{results: [{doc_id, status: moved|unchanged|forbidden|not_found|failed, detail?}]}`. Forbidden and not-found are both reported as `not_found` when the caller can't read the document, so existence doesn't leak.

**6. Upload target via a side table.** `upload_task_spaces(task_id PK, space_id)` (30-day retention like `upload_task_members`). `POST /api/documents/upload` takes an optional multipart field `space_id`; it is validated with `canPlaceInto` before any file is sent (403 otherwise). `HomeSpaceService.assign` resolves the uploader as today, then uses the task's recorded space when present and still valid, otherwise the personal space. If the uploader lost editor rights in between, it falls back to their personal space and logs `home_space_upload_target_revoked`.

**7. Library space column and filter.** Rows and detail payloads carry `home_space {id, name, kind}` (one `document_spaces ⋈ spaces` lookup per page, not per row). `?space=<id>` is validated against the member's spaces (403 otherwise) and translated to Paperless `id__in=<doc ids of the space>`. Paperless requests are GETs, so very large spaces risk the request-line limit. Task 3.3 measures the limit on the e2e Paperless; above a safe threshold (initially 1,000 ids) the filter falls back to fetching the space's documents in id chunks and merging client-side with the requested ordering. The live install has 257 documents, so the fallback is a safety net. *Alternative:* a `space` custom field per document filtered with `custom_field_query` — scales better, but writes every live document at deploy; kept as the follow-up if the limit bites.

**8. Inbox for viewers.** If the member is `viewer` in no space (the common case, and always true for a household of one), the inbox query is unchanged. Otherwise `listPending` excludes documents of the member's viewer spaces with Paperless `id__in` over the pending documents that remain (pending sets are small; the first page of pending ids is fetched with `fields=id`, capped at 500), and the live-counts inbox number uses the same rule. The detail page still opens for a viewer (read is allowed) but approve/reject are hidden and refused by policy.

**9. API surface (`spaces/` module, scope `spaces:manage` for every member).**
- `GET /api/spaces` → `{household_member_count, spaces: [{id, name, kind, role, owner, member_count, document_count}]}`
- `POST /api/spaces {name}` → 201 space; `PATCH /api/spaces/:id {name}`; `DELETE /api/spaces/:id` (owner, empty incl. trash → else 409)
- `GET /api/spaces/:id/members`; `POST /api/spaces/:id/members {member_id, role}`; `PATCH /api/spaces/:id/members/:member_id {role}`; `DELETE /api/spaces/:id/members/:member_id` (owner; or self = leave; never the owner)
- `POST /api/documents/:doc_id/move {space_id}`; `POST /api/spaces/:id/documents {doc_ids}` (bulk)
- `GET /api/household/directory` → `[{id, username}]` (any member)
Spaces the caller isn't in answer 404. Personal spaces refuse rename, delete and membership edits with 409. Every route goes into `route-inventory.test.ts`.

"Empty incl. trash": `document_spaces` rows stay for trashed documents (Paperless soft-delete keeps the id), so "no `document_spaces` row for this space" is the check. A hard delete via the trash service also deletes the row (added there).

**10. SPA.**
- `useSpaces` (query key `["spaces"]`, staleTime 30 s; invalidated by every space mutation and by move/bulk move, which also invalidate `library` + `inbox` + `document`).
- `/akten` page: list of my spaces (name, role, owner, members, documents → link to `/library?space=<id>`), create form, and for each owned shared space rename / members (directory picker, role select, remove) / delete (disabled with a hint while not empty); non-owners get "Verlassen".
- Nav entry "Akten" and every other space UI shown only when `household_member_count ≥ 2`.
- `/upload`: space select (owner/editor spaces, default personal) sent as `space_id`.
- Library: "Akte" column / card line, "Akte" filter select (`?space=`), and "Verschieben nach…" in the multi-select action bar with a per-document result summary. The multi-select bar exists on the review tab today; the archive tab gets checkboxes for this.
- Detail pages: `HomeSpaceBadge` stays; a "Verschieben" control (select of target spaces + confirm) is shown when the caller owns the current space.

## Risks / Trade-offs

- **Move half-applied** (Paperless OK, Qdrant down, compensation also fails) → the document's chunks still carry the old space, so old-space members could retrieve them through Ask. Mitigation: compensation, the `space_move_compensation_failed` error log, and the worker's startup reconcile extended to re-set `space_id` for documents whose chunks disagree with `document_spaces` (`countChunksOutsideSpace` exists).
- **Paperless owner switches on move into someone else's space** → the mover loses delete rights in Paperless, which matches the aktenraum role (they're an editor there).
- **Request-line limit for `id__in`** → measured, chunked fallback (Decision 7).
- **Group membership drift** (someone edits groups in the Paperless admin UI) → `syncSpaceMembership` runs on every membership change and from the tenancy migration's verify step, which reports drift.
- **Rollback**: reverting the code leaves the new tables unused; documents moved into shared spaces keep their Paperless permissions, and the old code treats the shared space like any other space through `document_spaces`, so access stays correct.

## Migration Plan

No data migration. Deploy = `task build`. The personal-space permission target is unchanged, so `mirrorDocument` is a no-op for every existing document. New tables are created by `applySchema`. Verify on the live install after deploy: create a test shared space, add the second member as viewer, upload into it, move one document in and out, check isolation from both accounts and that Ask follows, then delete the test space.

## Open Questions

- Exact safe size for `id__in` on Paperless 2.20 (measured in task 3.3).
