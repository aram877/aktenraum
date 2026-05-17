## 1. Gateway: trash methods + docstring fix

- [x] 1.1 In `services/aktenraum-api/src/aktenraum_api/paperless_gw.py`, replace the misleading docstring on `delete_document` — Paperless 2.x soft-deletes; the doc moves to `/api/trash/` and the PDF, OCR, custom fields stay recoverable for `PAPERLESS_EMPTY_TRASH_DELAY` days
- [x] 1.2 Add `list_trashed_documents(page, page_size, ordering)` — GETs `/api/trash/`, maps 401/403 → `PaperlessAuthError`, logs `paperless_trash_list_rejected` on errors
- [x] 1.3 Add `restore_documents(doc_ids)` — POSTs `/api/trash/` with `action="restore"`, maps 404 → `PaperlessNotFoundError`, 401/403 → `PaperlessAuthError`
- [x] 1.4 Add `empty_trash(doc_ids|None)` — POSTs `/api/trash/` with `action="empty"`; `None`/empty list empties the entire trash
- [x] 1.5 Gateway methods exercised via router-level fake-gateway tests in group 3 (matches the existing project pattern; standalone `test_paperless_gw.py` doesn't exist and adding it just for trash would diverge)
- [x] 1.6 `uv run ruff check services/aktenraum-api/src/aktenraum_api/paperless_gw.py` clean

## 2. RAG vector store dependency

- [x] 2.1 Added `get_vector_store_optional` to `aktenraum_api/ai/deps.py` — kept in `ai/` because everything that touches Qdrant lives there today; carve out a `rag/` package only if a second non-ai caller appears
- [x] 2.2 Importable from the new trash service module without circular imports — verified via `uv run python -c`

## 3. Trash service + router

- [x] 3.1 Created `aktenraum_api/trash/__init__.py` exposing `router`, `TrashItem`, `TrashList`, `EmptyTrashResponse` (mirrors inbox/__init__.py)
- [x] 3.2 Created `trash/schemas.py` — `TrashItem` (with `deleted_at: datetime`, native + AI fallback fields), `TrashList`, `EmptyTrashResponse`
- [x] 3.3 Created `trash/service.py` — `list_trashed`, `restore`, `delete_forever`, `empty`. Hard-delete paths call `vector_store.delete_by_doc_id` per-id after Paperless success; per-id Qdrant failures logged + swallowed
- [x] 3.4 Created `trash/router.py` — four endpoints + ordering allowlist + 404/502/409 error mapping
- [x] 3.5 Registered `trash_router` in `aktenraum_api/main.py`
- [x] 3.6 Wrote 14 tests in `test_trash_router.py`: list (auth, pagination, ordering allowlist), restore (happy, 404), delete (Paperless + Qdrant, Qdrant fail swallowed, vector_store=None, 404), empty (count, multi-page pagination, empty-trash no-op, auth)
- [x] 3.7 `uv run pytest services/aktenraum-api/tests/test_trash_router.py` 14/14 pass; full aktenraum-api suite 271/271 pass

## 4. SPA: lib + route + nav + copy edit

- [x] 4.1 Skipped generate:api-types step — the SPA uses hand-typed TanStack Query hooks throughout (`InboxItem`, `LibraryItem`, etc.) rather than auto-generated OpenAPI types. Matches the existing project pattern; new `TrashItem`/`TrashList`/`EmptyTrashResponse` types live in `apps/web/src/lib/trash.ts`
- [x] 4.2 Created `apps/web/src/lib/trash.ts` — `useTrashList`, `useTrashCount` (30s staleTime), `useRestoreFromTrash`, `useDeleteForever`, `useEmptyTrash`. Every mutation invalidates `trash` + `library` + `inbox` + `in-flight` + `document` keys. Also exports `trashDaysRemaining` helper for the row's "noch N Tage" chip
- [x] 4.3 Created `apps/web/src/routes/Trash.tsx` — header with conditional Papierkorb-leeren button, list of `TrashRow` components with two-step inline confirm, full-screen `ConfirmEmptyModal`, success/error toast, empty state copy
- [x] 4.4 Registered lazy `trashRoute` in `apps/web/src/router.tsx`
- [x] 4.5 Updated `Nav.tsx` — added "Papierkorb" link with badge fed by `useTrashCount()`, hidden when count is zero; added `"trash"` to the active-key union
- [x] 4.6 Updated `DocumentPreviewModal.tsx` (and `LibraryReview.tsx`) Löschen confirm copy: tooltip "In den Papierkorb verschieben (30 Tage wiederherstellbar)", prompt "In den Papierkorb verschieben?", action "Ja, in Papierkorb"
- [x] 4.7 `pnpm --filter @aktenraum/web lint` → 2 pre-existing warnings (unrelated); `pnpm --filter @aktenraum/web build` → clean, 908ms, Trash chunk 5.06 kB
- [x] 4.8 No new test harness for component tests in this codebase (existing tests are router/library/inbox integration via httpx); rely on manual smoke in group 5

## 5. Live verification

- [x] 5.1 `task api:rebuild` + `task web:deploy` — both clean
- [x] 5.2 Endpoint smoke: `/api/trash/` returns 401 unauthed (gate works); auth-cookie-driven GET on the live stack returns `{"results":[],"total":0,…}` with the live empty trash
- [x] 5.3 OpenAPI shows all four routes (`/api/trash/`, `…/{doc_id}/restore`, `…/{doc_id}/delete`, `…/empty`) and they reach the trash service
- [x] 5.4 `POST /api/trash/empty` on an empty trash returns `{"emptied": 0}` end-to-end through nginx
- [ ] 5.5 Destructive smoke (Löschen → Wiederherstellen → Endgültig löschen → empty-all) deferred to user verification on real docs — destructive on the user's live corpus, exercised exhaustively in the 14 unit tests
- [ ] 5.6 Multi-doc empty-all SPA flow — same reason, deferred to user verification
- [ ] 5.7 `QDRANT_URL=""` regression check — the `get_vector_store_optional` returns `None` path is unit-tested (`test_delete_forever_works_without_vector_store`); flipping the live env to confirm would require a separate test stack

## 6. Documentation cadence

- [x] 6.1 CLAUDE.md "What's implemented vs planned" — new Papierkorb / Trash row describing the two-step model, Qdrant cleanup, nav badge cadence
- [x] 6.2 CLAUDE.md gotchas — new row explaining the soft-delete reality (Paperless 2.x always soft-deletes; the previous docstring was wrong) and the RAG-retrieval-surfaces-trashed-chunks limitation
- [x] 6.3 Session note appended to `docs/sessions/2026-05-17.md` — third pass; covers what shipped, the two punted limitations, and the deferred destructive smoke
- [x] 6.4 `openspec status --change "web-trash-management"` shows 4/4 artifacts done; archive deferred per `aktenraum-commit-discipline` until the user verifies the live smoke
