## 1. Schema, policy, mirror

- [x] 1.1 `document_shares` + `share_audit` in `schema.ts`, `schema.sql`, pg-mem harness; `apply-schema.test.ts` green; verify on a throwaway `postgres:15` (apply twice, unique + check constraints reject bad rows)
- [x] 1.2 `TenancyService.documentAccess` returns `share` role + `via`; `PolicyService` actions `edit-fields` and `share` per the role table (design §2); worker keeps type-field writes. Verify: policy matrix test (space viewer/editor/owner × share viewer/editor × active/expired × admin-unassigned × worker)
- [x] 1.3 Move `PATCH /fields` and `PATCH /type-fields` to `@DocumentAccess("edit-fields")`. Verify: existing documents/type-fields route tests still pass, plus a share-editor case (allowed) and a share-viewer case (404)
- [x] 1.4 `mirrorDocument` adds active share users (`view.users`, editors also in `change.users`, sorted); `qdrantSpaceFor(docId)` helper used by the tenancy endpoint and the move code. Verify: mirror test (no shares → `unchanged` for an existing document; viewer/editor/expired shares → expected target); move regression test keeps `shared_with`; `GET /api/tenancy/documents/:doc_id/space` returns active recipients

## 2. Shares API

- [x] 2.1 `shares/` module: grant / change / revoke with the compensation sequence (design §4), validation (self, unknown member, member of the home space, duplicate → 409/422, past expiry → 422), audit entries. Verify: route tests incl. compensation on Paperless failure and on Qdrant failure
- [x] 2.2 `GET /documents/:doc_id/shares`, `/shares/audit`, `GET /api/shares/with-me`, `/by-me`; scope `shares:manage`; route inventory updated. Verify: route tests (owner sees, editor-of-space/recipient/outsider get 404; trashed documents left out; "by me" follows a move)
- [x] 2.3 `expireDue` (periodic every 5 min + caller-scoped at the start of library, with-me, inbox, live counts, Ask). Verify: tests where an expired share disappears from library, with-me and Ask candidates on the next request, the sweep re-mirrors and clears `shared_with`, and a failed mirror leaves the row for a retry
- [x] 2.4 Access audit: `@ShareAccessKind` on detail/preview/download, Ask `ask` entries for cited shared documents, hourly dedup per share and kind, best-effort writes. Verify: tests (one entry for two downloads within the hour, separate kinds logged, space members not logged, audit failure doesn't fail the request)

## 3. Library, inbox, detail payloads

- [x] 3.1 Library rows + detail payloads: `home_space: null` + `shared_by` for shared documents; `access: {via, role}` on detail payloads. Verify: route test (recipient never receives the sharer's space name)
- [x] 3.2 Inbox list + live-counts inbox exclude documents shared with the member. Verify: tests (pending shared document absent for the recipient, present for the owner; single member query unchanged)
- [x] 3.3 Few-shot / history hint / duplicate isolation regression. Verify: worker + api tests that a document shared with B is never an example, hint source or duplicate candidate for B's documents

## 4. Web

- [x] 4.1 `useShares`, `useSharedWithMe`, `useSharedByMe` + mutations with invalidation per the spa-data-fetching rules. Verify: composable tests
- [x] 4.2 `SharePanel.vue` on `/library/[id]` (owner only): member picker, role, optional expiry date, list with role/expiry edit + revoke, audit list. Verify: `mountSuspended` tests (owner sees it, editor/recipient don't, grant/revoke call the right endpoints)
- [x] 4.3 `/geteilt` page (two tabs) + nav entry, both hidden for one member; "Geteilt von" badge; detail pages hide write actions for share access and make fields read-only for share viewers. Verify: `mountSuspended` tests for each
- [x] 4.4 Full suite green: `pnpm -r lint`, `pnpm -r build`, api + web typecheck, `pnpm -r test`

## 5. Docs + verify

- [ ] 5.1 Worker e2e (`bash scripts/e2e-worker.sh`) + a share rehearsal on the e2e stack: viewer share read through the recipient's own token, editor edits but can't approve, inbox absence, Ask retrieves it only for the recipient, revoke → 404 + Paperless denies, expiry ends access, audit entries present
- [x] 5.2 ADR-009 "as built" note, CLAUDE.md (shares, counts, gotchas), api-reference.md, session note

## Workflow follow-up

- Live deploy via `docs/runbooks/upgrade-existing-install.md`, then the post-deploy check in design.md "Migration Plan".
- `/opsx:archive tenancy-document-shares`.
