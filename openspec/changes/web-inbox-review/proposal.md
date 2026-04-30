## Why

Phase 2 gave the user a way to *find* documents; Phase 3 gives them the workflow that makes the AI layer trustworthy in the first place — a fast, focused review queue for `ai-pending` documents. Without it, the only way to approve or reject AI extractions is to open Paperless's admin UI, hunt for the right tag, and edit a sea of unlabelled custom fields. That contradicts the entire premise of the rewrite.

The output is a two-pane page: PDF preview on the left, editable AI fields on the right, with approve/reject and keyboard shortcuts (a / r / j / k). One pending doc at a time, auto-advance to the next on action. Every AI field on the right side is editable; on Approve, the SPA sends the user's edits as a patch and then flips the lifecycle tag, so corrections propagate into Paperless's native fields via the existing propagation watcher.

This phase only changes the SPA's shape and adds a thin inbox-shaped wrapper around the Paperless gateway already landed in Phase 2 — no new infra, no DB migrations, no LLM calls.

## What Changes

- **New `/api/inbox/*` endpoints** in `aktenraum-api`, all auth-gated:
  - `GET /api/inbox/` — paginated list of `ai-pending` documents. Returns `{results, total, page_size, page}` with `InboxItem` shape (id, title, created, low_confidence, ai_correspondent, ai_document_type, ai_issue_date, ai_monetary_amount, ai_confidence). Sorted oldest-first so the queue drains FIFO.
  - `GET /api/inbox/{id}` — full review payload: every `ai_*` custom field, the document's content excerpt (first ~2k chars), current tag list (so the SPA can mark low-confidence), correspondent / document-type guesses with their resolved-vs-unknown status against the live Paperless lists.
  - `PATCH /api/inbox/{id}` — partial update of the `ai_*` fields. Body is `InboxFieldUpdate` (every field optional). Server-side normalisers run at the boundary (date strict ISO, monetary `<ISO><amount>`, string ≤128 chars) — same rules the auto-tagger writes.
  - `POST /api/inbox/{id}/approve` — accepts an optional `InboxFieldUpdate` body. If present, runs the patch first; then replaces the `ai-pending` tag with `ai-approved` (the propagation watcher picks it up within 30s).
  - `POST /api/inbox/{id}/reject` — replaces `ai-pending` with `ai-rejected`. No fields touched.
  - `GET /api/inbox/{id}/preview` — streaming proxy to Paperless's `/api/documents/{id}/preview/`. Auth-gated by the SPA cookie. Sets `Content-Type: application/pdf` and `Cache-Control: private, max-age=300`.
- **New `aktenraum_api/inbox/` package** mirrors the `ai/` layout: `schemas.py`, `service.py` (the read/write logic against the gateway), `router.py`, and a `state.py` helper for the lifecycle-tag swap. Pure functions where possible, gateway-dependent functions take the gateway as an arg.
- **Gateway extension**: `PaperlessGateway` gains `get_document(id)`, `patch_document_custom_fields(id, name_to_value)`, `swap_lifecycle_tag(id, *, remove, add)`, `stream_preview(id)`. The custom-field PATCH normalises monetary / date / string-length at the boundary using the existing `aktenraum_core.paperless.normalisers` helpers (already extracted in Phase 0; we just import them).
- **New SPA routes**:
  - `/inbox` — list view: count badge + table of pending docs, low-confidence rows highlighted, click row → review.
  - `/inbox/$id` — two-pane review: left = PDF iframe (`<iframe src="/api/inbox/{id}/preview" />`), right = scrollable form with all 12 ai_* fields, Approve / Reject buttons, "next" auto-navigation.
  - Keyboard shortcuts on the review page: `a` Approve, `r` Reject, `j`/`k` next/prev pending doc, `escape` back to list.
- **Nav link** added to the home + ask layouts: "Inbox" with a count badge fed from `GET /api/inbox/?page_size=1` (just to read `total`).
- **Type generation**: schemas land in `/api/openapi.json`; the SPA's `pnpm generate:api-types` picks them up. We don't ship hand-typed clones.
- **Test coverage**:
  - Pure-function tests for the lifecycle-tag swap logic, low-confidence detection, and the field-update validation rules.
  - Router tests for each endpoint with a fake gateway (mocked Paperless responses).
  - Preview-proxy test that asserts the response stream is forwarded with the right content-type and that auth is required.
- **Documentation**: `docs/plans/custom-frontend.md` flips Phase 2 → done, Phase 3 → in progress; `CLAUDE.md` gets a short "Inbox review" subsection under aktenraum-api notes; the env example is unchanged.

## Capabilities

### New Capabilities

- `aktenraum-api/inbox`: HTTP endpoints for listing, reading, patching, approving, and rejecting pending AI extractions, plus a PDF preview proxy. Owns the lifecycle-tag swap and the field-update validation that mirrors the auto-tagger's normalisers.
- `aktenraum-web/inbox`: Two-screen UI (list + review) for working through the pending queue, including the keyboard-shortcut workflow.

### Modified Capabilities

- `aktenraum-api/paperless-gateway`: extended with `get_document`, `patch_document_custom_fields`, `swap_lifecycle_tag`, `stream_preview`. No breaking change to the existing methods.
- `aktenraum-web/ask-page`: nav row gets an "Inbox" link with a count badge.
- `aktenraum-web/home`: same nav-row addition.

## Impact

- **No new env vars, no DB migrations, no new dependencies.** The phase is a pure feature add on top of the gateway and SPA wiring landed in Phase 2.
- **The propagation watcher in `auto-tagger` is not touched.** Approve still means "set `ai-approved`" — the same trigger that already works. The user just stops needing Paperless's admin UI to do it.
- **Backward compatible**: existing `/api/ai/*` and `/api/auth/*` endpoints unchanged. SPA routes added, none removed; the home page stays as the entry point.
- **Performance**: the list view fetches one page (default 20) of `ai-pending` docs per render plus a tiny "/inbox/?page_size=1" call from each layout for the count badge. Below the noise floor at personal-DMS scale.
- **PDF preview**: streamed through aktenraum-api so the Paperless API token never reaches the browser. Browser caches privately for 5 minutes per doc — fine because preview content is immutable per doc id.
