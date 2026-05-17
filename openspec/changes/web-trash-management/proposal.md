## Why

Today the SPA's "Löschen" button claims to permanently delete a document — the docstring at `services/aktenraum-api/src/aktenraum_api/paperless_gw.py:287-294` explicitly says "Paperless does not soft-delete — once removed, the PDF, OCR, and all custom-field values are gone." That is **wrong**. Paperless-ngx 2.x always soft-deletes via `DELETE /api/documents/{id}/`; the doc lands in `/api/trash/` where it sits for `PAPERLESS_EMPTY_TRASH_DELAY` (default 30 days) before auto-purge. Every doc a user has "deleted" from the SPA is recoverable from Paperless's admin UI — but the SPA never exposed that, so the user's mental model and the actual state diverge.

There is also a second, smaller bug surfaced by the same investigation: the gateway's `delete_document` never touches Qdrant, so chunks for soft-deleted docs stay searchable via RAG. The reviewer-flagged "user deletes a doc but RAG still answers from it" failure mode is real today.

This change does three things at once because they share one mental model (Trash) and one set of integration points (Paperless `/api/trash/` + Qdrant `delete_by_doc_id`):

- Stops misleading the user about what "Löschen" means by surfacing a real Trashbin / Papierkorb view of soft-deleted docs.
- Adds the actions the user needs from that view: per-doc Wiederherstellen (restore), per-doc Endgültig löschen (hard-delete), and a top-level Papierkorb leeren (empty all).
- Makes hard-delete actually hard by purging Qdrant chunks for the affected ids alongside the Paperless trash-empty call.

## What Changes

- **`PaperlessGateway` gains three trash methods**:
  - `list_trashed_documents(page, page_size, ordering) -> dict` — `GET /api/trash/?page=…&page_size=…`, returns the standard `{count, next, previous, all, results}` payload.
  - `restore_documents(doc_ids: list[int]) -> None` — `POST /api/trash/ { "documents": [...], "action": "restore" }`.
  - `empty_trash(doc_ids: list[int] | None) -> None` — `POST /api/trash/ { "documents": [...], "action": "empty" }`; `None` means empty everything currently in trash (matching Paperless's contract when `documents` is omitted).
- **`delete_document` docstring corrected** — replace the wrong "no soft-delete" claim with the actual behaviour (soft-delete; doc moves to `/api/trash/`).
- **New `aktenraum_api/trash/` package** (mirrors the layout of `aktenraum_api/inbox/`):
  - `schemas.py` — `TrashItem`, `TrashList`, response models for restore / empty actions.
  - `service.py` — `list_trashed`, `restore`, `delete_forever`, `empty`. The hard-delete-paths (`delete_forever`, `empty`) additionally call `vector_store.delete_by_doc_id(doc_id)` per affected id when `app.state.rag_vector_store` is configured.
  - `router.py` — endpoint catalog below.
- **New endpoints under `/api/trash/`**, all auth-gated, all idempotent:
  - `GET /api/trash/?page=&page_size=&ordering=` — paginated list of trashed docs (oldest-first by default so "expires next" is at the top).
  - `POST /api/trash/{id}/restore` — restore one doc (204).
  - `POST /api/trash/{id}/delete` — hard-delete one doc + purge its Qdrant chunks (204).
  - `POST /api/trash/empty` — hard-delete every trashed doc + purge their Qdrant chunks (204). Body is empty.
- **Vector-store dependency injection**: a new `get_vector_store_optional(request)` dependency returns `request.app.state.rag_vector_store` or `None`; the trash service handles the None case as a no-op so the change works when `QDRANT_URL` is unset.
- **New SPA route `/trash`**: table of trashed documents (title, deleted-on, suggested correspondent, suggested doctype, days-until-auto-purge), per-row Wiederherstellen + Endgültig löschen buttons with inline confirm, top-bar "Papierkorb leeren" button with full-screen confirm.
- **SPA Nav link** with a small count badge fed by `GET /api/trash/?page_size=1` (re-uses the existing 30-second polling cadence the in-flight pill uses).
- **`apps/web/src/lib/trash.ts`**: TanStack Query keys + mutations; every mutation invalidates `trash`, `library`, `inbox`, `in-flight`, and the per-doc preview queries so the badge and library row state stay in sync.
- **`DocumentPreviewModal`'s existing Delete button is unchanged in behaviour** — it already soft-deletes via the existing endpoint. We update its German confirmation copy from "Wird unwiderruflich entfernt" to "Wird in den Papierkorb verschoben (30 Tage Wiederherstellung möglich)" so the SPA stops lying.
- **Test coverage**:
  - Gateway unit tests for the three new methods (good path + 404 + auth-error mapping).
  - Trash service tests for the list/restore/delete-forever/empty paths, including the "Qdrant is None → still works" path.
  - Trash router tests for happy paths, auth gating, and 404 mapping.
  - One SPA component test for the row-level confirm + cache-invalidation behaviour (existing testing pattern in `apps/web/src/__tests__`).

## Capabilities

### New Capabilities
None — the trash flow is an extension of the existing `aktenraum-api` and `aktenraum-web` capabilities, not a new domain.

### Modified Capabilities
- `aktenraum-api`: new requirements for the trash endpoints (`GET /api/trash/`, restore, single-doc hard-delete, empty) and updated delete semantics (delete is soft, hard-delete purges Qdrant).
- `aktenraum-web`: new requirements for the `/trash` route, nav badge, and updated copy on the existing Delete confirm.

## Impact

- **Code**:
  - `services/aktenraum-api/src/aktenraum_api/paperless_gw.py` — three new methods, docstring fix on `delete_document`.
  - `services/aktenraum-api/src/aktenraum_api/trash/` (new package) — `__init__.py`, `schemas.py`, `service.py`, `router.py`.
  - `services/aktenraum-api/src/aktenraum_api/main.py` — register the new router under `/api`.
  - `services/aktenraum-api/src/aktenraum_api/ai/deps.py` (or a new `aktenraum_api/rag/deps.py`) — `get_vector_store_optional` dependency.
  - `apps/web/src/routes/Trash.tsx` (new), `apps/web/src/lib/trash.ts` (new).
  - `apps/web/src/components/Nav.tsx` (or wherever the top-bar lives) — Trashbin link + badge.
  - `apps/web/src/router.tsx` — register the lazy `/trash` route.
  - `apps/web/src/components/DocumentPreviewModal.tsx` — German copy update on the existing confirm.
- **Docs**:
  - `CLAUDE.md` — new row in the implemented table; correction of the misleading delete behaviour note if one exists; gotchas row noting that RAG retrieval still surfaces chunks of trashed-but-not-emptied docs until the empty step runs.
  - `docs/sessions/<date>.md` — session note when shipped.
- **Operational**:
  - Existing trashed docs (from past SPA deletions before this change shipped) become visible to the user. Since the default `PAPERLESS_EMPTY_TRASH_DELAY` is 30 days and the live `/api/trash/` is currently empty (verified on the dev host), there is no migration concern.
  - Qdrant orphaned-chunks cleanup for the existing corpus is NOT part of this change. If a buyer has docs that were soft-deleted before this change shipped, their Qdrant chunks live on until those docs get hard-deleted via the new empty-trash UI (or auto-purged by Paperless after 30 days, at which point the chunks become permanently orphaned). One-shot cleanup can be a follow-up `scripts/cleanup-orphaned-rag-chunks.py`.
- **Out of scope** (intentionally):
  - Filtering RAG retrieval to exclude chunks of currently-trashed docs at query time. Real fix but expensive (per-candidate Paperless round-trip or new chunk payload field). Document the limitation, ship a follow-up if it shows up in eval.
  - Auto-empty / scheduled cleanup. Paperless's own `PAPERLESS_EMPTY_TRASH_DELAY` handles this; we don't second-guess it.
  - Multi-select / bulk-restore in the trash view. Empty-all + per-row Endgültig löschen covers the realistic cases for a personal DMS at this scale.
