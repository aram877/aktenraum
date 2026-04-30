## 1. Gateway extensions

- [ ] 1.1 Add `get_document(id)` to `PaperlessGateway` (full doc payload incl. content + custom_fields).
- [ ] 1.2 Add `patch_document_custom_fields(id, name_to_value: dict)` — resolves field ids on first call (cached on the gateway), runs `_normalize_monetary` / `_normalize_date` / `_truncate_string_field` from `aktenraum_core.paperless.normalisers` at the boundary, sends one PATCH.
- [ ] 1.3 Add `swap_lifecycle_tag(id, *, remove: list[str], add: list[str])` using `LIFECYCLE_TAGS` (and `ai-low-confidence` as a constant) from `aktenraum_core.paperless`. Pure planning helper extracted as `_plan_tag_swap(current_ids, name_to_id, remove, add) -> list[int]` for unit testing.
- [ ] 1.4 Add `stream_preview(id) -> AsyncIterator[bytes]` opening `/api/documents/{id}/preview/` with `httpx.AsyncClient.stream`. Caller is responsible for closing.
- [ ] 1.5 Add `list_tags()` returning `{name: id}` (cached with the same TTL as correspondents) so the swap doesn't fetch tag ids per call.

## 2. Inbox schemas

- [ ] 2.1 `services/aktenraum-api/src/aktenraum_api/inbox/__init__.py` re-exports `router`, `InboxItem`, `InboxDetail`, `InboxFieldUpdate`, `InboxList`.
- [ ] 2.2 `inbox/schemas.py`:
  - `InboxItem` (id, title, created, ai_correspondent, ai_document_type, ai_issue_date, ai_monetary_amount, ai_confidence, low_confidence: bool).
  - `InboxDetail` extends `InboxItem` with the remaining `ai_*` fields, content excerpt, and the full tag list (names not ids) for the SPA's badges.
  - `InboxFieldUpdate` — every field optional; field names mirror the Paperless custom-field names exactly.
  - `InboxList` (results, total, page, page_size).

## 3. Inbox service + router

- [ ] 3.1 `inbox/service.py`:
  - `list_pending(gateway, *, page, page_size) -> InboxList` — calls `gateway.list_tags()` for the `ai-pending` id, hits `/api/documents/?tags__id=<id>&ordering=created&page=<page>&page_size=<page_size>`, projects each result via `_project_inbox_item`.
  - `get_detail(gateway, doc_id) -> InboxDetail` — single-doc fetch + content excerpt (first 2k chars) + tag-name resolution.
  - `apply_field_update(gateway, doc_id, update: InboxFieldUpdate) -> InboxDetail` — calls `patch_document_custom_fields` with only the populated fields, returns the refreshed detail.
  - `approve(gateway, doc_id, update: InboxFieldUpdate | None) -> InboxDetail` — patch (if any), then swap `ai-pending` + `ai-low-confidence` → `ai-approved`.
  - `reject(gateway, doc_id) -> InboxDetail` — swap `ai-pending` + `ai-low-confidence` → `ai-rejected`.
- [ ] 3.2 `inbox/router.py`: register the five JSON endpoints + the streaming preview endpoint under `/api/inbox`. Auth-gated via `Depends(get_current_user)`; gateway via `Depends(get_paperless_gateway)`.
- [ ] 3.3 Wire `inbox_router` into `create_app()` in `main.py`.
- [ ] 3.4 Preview proxy returns `StreamingResponse(stream_preview(id), media_type="application/pdf", headers={"Cache-Control": "private, max-age=300"})`. On Paperless 401/403 → 502; on 404 → 404.

## 4. SPA — list view

- [ ] 4.1 `apps/web/src/lib/inbox.ts` — `fetchInboxList`, `fetchInboxDetail`, `patchInbox`, `approveInbox`, `rejectInbox`, plus TanStack Query hooks (`useInboxList`, `useInboxDetail`, `useApprove`, `useReject`, `useInboxPatch`).
- [ ] 4.2 `apps/web/src/routes/Inbox.tsx` — table of pending docs (title, correspondent guess, doc-type guess, date, confidence). Low-confidence rows get a yellow left border; click row → `/inbox/$id`.
- [ ] 4.3 `Inbox.tsx` empty state: "Keine offenen Dokumente." plus a link to /ask.
- [ ] 4.4 Add a `<Nav />` shared layout component (small) consumed by Home, Ask, and Inbox so the nav bar / count badge code lives once.

## 5. SPA — review view

- [ ] 5.1 `apps/web/src/routes/InboxReview.tsx` — two-column grid: left iframe `<iframe src="/api/inbox/{id}/preview" />`, right scrollable form.
- [ ] 5.2 Form fields: ai_document_type (select w/ 20 options), ai_correspondent (text), ai_issue_date / ai_due_date / ai_expiry_date (date inputs), ai_monetary_amount (text), ai_reference_numbers (text), ai_suggested_tags (text), ai_summary_de (textarea). The 12 ai_* fields surface; ai_confidence + ai_backend + ai_model render read-only.
- [ ] 5.3 Two buttons: Approve (primary) and Reject. Approve sends the current dirty form values as the patch body; Reject ignores them.
- [ ] 5.4 Auto-advance: on success, navigate to the next pending doc id from the cached list; if none left, navigate to `/inbox`.
- [ ] 5.5 Low-confidence banner if the tag is set; render `ai_confidence` next to each field on a colour scale.
- [ ] 5.6 `apps/web/src/lib/keyboard.ts` — `useKeyboardShortcuts({ a: onApprove, r: onReject, j: next, k: prev, Escape: back })`. Skip when focus is inside an input/textarea.

## 6. Nav + count badge

- [ ] 6.1 `apps/web/src/components/Nav.tsx` exposes a horizontal nav with current page indicator + Inbox count badge (uses `useInboxList({ pageSize: 1 })` and reads `total`).
- [ ] 6.2 Refactor Home + Ask to use the shared Nav.

## 7. Tests

- [ ] 7.1 `tests/test_inbox_tags.py` — `_plan_tag_swap` cases: removes lifecycle by name, adds new lifecycle, idempotent re-swap, removes auxiliary `ai-low-confidence` when present.
- [ ] 7.2 `tests/test_inbox_service.py` — pure-ish: `_project_inbox_item` against a fixture doc maps every field correctly, `low_confidence` true iff `ai-low-confidence` tag present.
- [ ] 7.3 `tests/test_inbox_router.py` — auth gate (401), list (paginates), detail (404 if doc missing), patch (calls gateway with normalised values), approve (patch + swap, idempotent if already approved → returns current state without re-swap), reject (swap), preview (streams bytes; 401 without cookie; 502 on upstream auth fail).
- [ ] 7.4 `tests/test_inbox_normalisers.py` — re-exports of monetary/date/string-trunc behave the way the auto-tagger tests already document.
- [ ] 7.5 `uv run pytest` from workspace root — all green.

## 8. Documentation

- [ ] 8.1 `docs/plans/custom-frontend.md` — Phase 2 → done; Phase 3 → in progress.
- [ ] 8.2 `CLAUDE.md` — new "Inbox review" subsection under aktenraum-api notes (endpoints + flow), bump test count line, mark Phase 3 row in the implementation matrix.

## 9. End-to-end verification

- [ ] 9.1 `docker compose up -d --build aktenraum-api nginx`. All services healthy.
- [ ] 9.2 `curl -s http://localhost:8080/api/openapi.json | jq '.paths | keys'` includes the five new inbox routes.
- [ ] 9.3 Browser to `/inbox` after login: count matches Paperless's `tags__id=<ai-pending-id>` count.
- [ ] 9.4 Open one doc, observe PDF preview in the iframe, edit a field, hit Approve. Verify within 30s that `ai-approved` flipped to `ai-propagated` (propagation watcher logs).
- [ ] 9.5 Open another, hit Reject. Verify `ai-rejected` is set and `ai-pending` removed.
- [ ] 9.6 Keyboard shortcuts: J / K cycles, A approves, R rejects, Escape returns to /inbox.
