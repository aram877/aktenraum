## Context

After `tenancy-shared-spaces` (live 2026-11-20), every document has one home space in `document_spaces`. `PolicyService.canAccessDocument` decides by the caller's role in that space, and `@DocumentAccess` answers a denial with 404. Member requests reach Paperless with the member's own token (`MemberGateways.forPrincipal`). Members never log in to Paperless directly; their passwords are discarded after the token is minted. `paperless-mirror.ts` computes a document's target owner and permissions from its home space (groups only, `users: []`). The Qdrant payload already has an indexed `shared_with` field. Member retrieval already filters `space_id ∈ my spaces OR shared_with ∋ me`, but every writer sets `shared_with: []` (`GET /api/tenancy/documents/:doc_id/space` returns `[]`, and so do the move and migration code). Few-shot examples, the history hint and duplicate detection are keyed on the home space. Ask loads every retrieved document through the member's gateway, so Paperless drops documents the member can't read. There is no audit log yet. The api has no periodic jobs; retention so far is done lazily (`upload_tasks`).

See proposal.md for scope.

## Goals / Non-Goals

**Goals:** access through a share follows the same two layers as space access (aktenraum policy first, Paperless second), and Ask isolation follows too. Grant, change and revoke are atomic across DB, Paperless and Qdrant. Nothing on the live install changes at deploy.

**Non-Goals:** a general audit framework. `share_audit` is deliberately specific; ADR-010's audit log can absorb it later.

## Decisions

**1. Two tables.**
- `document_shares(id serial PK, paperless_doc_id int, member_id int → members, role text CHECK in (viewer, editor), expires_at timestamptz NULL, granted_by int → members, granted_at timestamptz default now(), UNIQUE(paperless_doc_id, member_id))`. A revoke deletes the row; history lives in the audit table.
- `share_audit(id bigserial PK, paperless_doc_id int, member_id int, actor_member_id int NULL, event text CHECK in (granted, role_changed, expiry_changed, revoked, expired, accessed), access_kind text NULL CHECK in (detail, preview, download, ask), at timestamptz default now())`, with an index on `(paperless_doc_id, at)`. `actor_member_id` is null for `expired`.
- "Active" is always evaluated in SQL as `expires_at IS NULL OR expires_at > now()`. This is the pg-mem `now()` gotcha from CLAUDE.md: never compare a stored timestamp against `Date.now()` in JS.
- Both tables go into `schema.ts`, `schema.sql` and the harness.

**2. Policy: share access and a narrower write action.**
- `TenancyService.documentAccess` additionally returns the caller's active share role (`share: viewer | editor | null`).
- `DocumentAction` gains `edit-fields` and `share`:
  - space `viewer` = {read}
  - space `editor` = {read, write, edit-fields}
  - space `owner` = {read, write, edit-fields, delete, move, share}
  - share `viewer` = {read}
  - share `editor` = {read, edit-fields}
- A space role wins over a share. Shares are refused anyway for members of the space (409), but a member may join the space after the share was granted.
- `PATCH /api/documents/:doc_id/fields` and `PATCH /api/documents/:doc_id/type-fields` move from `write` to `edit-fields`. The worker principal with `internal:type-fields-write` is allowed `edit-fields`, as it is `write` today. Everything else that writes (approve, reject, inbox PATCH, reprocess, star, dismiss-duplicate) stays on `write`, which share editors don't have.
- *Alternative:* share editors get `write`. Rejected: they could approve, reprocess and star, all of which change the owner's document state beyond "correct AI fields" (ADR-009).
- `documentAccess` also reports `via: space | share | admin`. The detail payloads expose it as `access: {via, role}`, so the SPA can hide actions it would only get refused for.

**3. Share management routes.** All are guarded by `@DocumentAccess("share")`, which means "owner of the home space". A non-owner gets 404, consistent with every other document route.
- `GET /api/documents/:doc_id/shares` → `[{member_id, username, role, expires_at, granted_at, granted_by}]` (active only)
- `POST /api/documents/:doc_id/shares {member_id, role, expires_at?}` → 201. 409 for an existing share or a member of the home space. 422 for self, a past expiry or an unknown member.
- `PATCH /api/documents/:doc_id/shares/:member_id {role?, expires_at?}` (`expires_at: null` clears it)
- `DELETE /api/documents/:doc_id/shares/:member_id`
- `GET /api/documents/:doc_id/shares/audit` → newest first, capped at 500
- `GET /api/shares/with-me` → `[{doc_id, title, shared_by, role, expires_at}]`
- `GET /api/shares/by-me` → `[{doc_id, title, member, role, expires_at, granted_at}]`. "By me" means documents whose home space I own, not "rows I granted", so it stays correct after a move.

New scope `shares:manage` for every member; all routes go into `route-inventory.test.ts`. Titles come from one `id__in` request through the caller's gateway, and documents the caller can no longer read (trashed) are left out.

**4. Grant / change / revoke = DB → Paperless → Qdrant, compensated.** This is the same pattern as moves:
1. write `document_shares`;
2. `mirrorDocument` with the **service** gateway, because only the Paperless owner may change permissions and the document owner can differ from the caller after a move into someone else's space;
3. `vectorStore.setSpaceByDocId(doc, {spaceId: home, sharedWith: <active recipient ids>})` when Qdrant is configured (no chunks = no-op);
4. on failure in 2 or 3: restore the previous row state, re-mirror (best effort, logged `share_compensation_failed`), respond 502;
5. write the audit entry and log `share_granted|share_changed|share_revoked`.

**5. Mirror target includes shares.** `spaceDocumentPermissions` stays as is. `mirrorDocument` adds `view.users = all active recipients` and `change.users = active editor recipients`, as sorted Paperless user ids (`provisionMemberUser` for each recipient). For a document without shares this is exactly today's target, so the live install reports `unchanged` everywhere. Moves pick up shares automatically because they mirror too.
- Fix: the move code passes `sharedWith: []` to Qdrant. Without a fix, a move would silently remove shared recipients from Ask. It must pass the active recipients; one helper `qdrantSpaceFor(docId)` is used by moves, shares and the tenancy endpoint.

**6. Expiry: exact in aktenraum, swept elsewhere.**
- The policy check is SQL, so access through aktenraum ends at the expiry instant.
- Paperless permissions and `shared_with` are derived state, and a stale grant there would still let the recipient's *list* calls (library, Ask candidates) see the document. So `SharesService.expireDue(memberId?)` processes due shares: mirror and Qdrant first (the target already excludes expired rows), then delete the row and audit `expired`. A failure leaves the row, so the next run retries.
- It runs every 5 minutes from an `onApplicationBootstrap` interval (unref'd, cleared on shutdown). It also runs, scoped to the caller, at the start of the library list, `/shares/with-me`, the inbox list, live counts and Ask. So a recipient never sees an expired document in a list, even between sweeps.
- *Alternative:* filter expired shares out of every list in code. Rejected: it breaks Paperless pagination counts and has to be repeated in every list.

**7. Library and detail labelling.** Library rows and detail payloads compute `home_space` from the one `document_spaces ⋈ spaces` lookup per page. For a document whose home space the caller isn't in, `home_space` is `null` and `shared_by: {username, role, expires_at}` is set instead. The sharer's space name never reaches the recipient. `?space=` stays limited to the caller's spaces, so shared documents appear only in the unfiltered library and on "Mit mir geteilt".

**8. Inbox exclusion.** Paperless returns pending documents shared with the member through their token. Since `tenancy-shared-spaces`, `listPending` excludes viewer-space documents with an id list. The excluded set becomes "documents of my viewer spaces ∪ documents shared with me". If both are empty (always true for a household of one), the query is unchanged. The live-counts inbox number uses the same set.

**9. Access audit.**
- A route-level decorator `@ShareAccessKind("detail" | "preview" | "download")` marks the three read routes. When the guard grants access `via: share`, it records `accessed` with that kind.
- Ask records `ask` for every cited document the caller reads through a share, after citations are resolved.
- Dedup is one `INSERT … SELECT … WHERE NOT EXISTS (same doc, member, kind, at > now() - interval '1 hour')`.
- Audit writes are best effort: a failure logs `share_audit_failed` and never fails the request.

**10. SPA.**
- `useShares(docId)`, `useSharedWithMe()`, `useSharedByMe()`, plus grant/change/revoke mutations.
- Query keys `["shares", docId]`, `["shares", "with-me"]`, `["shares", "by-me"]`, staleTime 30 s. Mutations invalidate `["shares"]` and `["document", docId]`.
- `components/shares/SharePanel.vue` on `/library/[id]`, shown when `access.role === "owner"`: member picker from the household directory minus members of the home space, role select, optional date (sent as the end of that day in the browser's time zone), current shares with role/expiry edit and revoke, and a collapsible audit list.
- `/geteilt` page with tabs "Mit mir geteilt" / "Von mir geteilt" (revoke inline), and a nav entry. Both only when `household_member_count ≥ 2`.
- `HomeSpaceBadge` shows "Geteilt von <name>" (with expiry) when `shared_by` is set.
- Detail pages hide approve/reject/reprocess/star/delete/move when `access.via === "share"`, and make fields read-only for share viewers.

## Risks / Trade-offs

- **Revoke half-applied** (DB row gone, Paperless still grants, compensation fails too) → the recipient's library may list the document while detail, preview and download answer 404 (policy). Ask would include it only if Paperless still grants it. Mitigation: compensation, the error log, and the sweep, which re-mirrors every document it touches. Since members can't log in to Paperless directly, a stale Paperless grant is only reachable through aktenraum.
- **Move drops `shared_with`** → fixed in Decision 5, with a regression test.
- **Audit volume** → bounded by the hourly dedup per share and kind. No retention policy yet (tiny rows); revisit with ADR-010's audit log.
- **Time zones for expiry** → the SPA sends an absolute timestamp (end of the chosen day locally) and the server stores and compares absolute times only.
- **Rollback**: reverting the code leaves the tables unused. Paperless still grants share recipients until a re-mirror. Reverting needs one pass of the tenancy migration's verify step to drop the share users (documented in the ADR note).

## Migration Plan

No data migration. Deploy = `task build`. The new tables are created by `applySchema`, and every existing document mirrors as `unchanged`. Verify after deploy:
1. share a test document with the second member as viewer, and check it from both accounts (library label, detail, download, Ask, inbox absence, audit entry);
2. upgrade to editor and correct a field; check that approve is refused;
3. set an expiry a few minutes ahead and watch access end;
4. revoke.
