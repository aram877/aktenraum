## 1. Auto-tagger: routing-decision reason

- [x] 1.1 `_route_lifecycle_tags` now returns `tuple[list[str], str]`; reason is one of four closed-enum values; routing behaviour unchanged. Extracted the pending-tag computation into a `_pending()` helper so the reason is computed once per gate
- [x] 1.2 `process_document` unpacks the tuple and logs `reason=` and `document_type=` on the existing `routing_decision` event
- [x] 1.3 Routing matrix in `test_tagger.py` extended with `expected_reason` column; 80/80 tests pass
- [x] 1.4 `uv run ruff check services/auto-tagger` clean (after ruff format)

## 2. Library backend: ordering + in-flight pin

- [x] 2.1 `LibraryItem` gains `is_processing: bool = False`
- [x] 2.2 `list_library` accepts `settings: Settings | None`; on `page == 1` and `auto_tagger_url` non-empty fetches `/processing` via the shared helper
- [x] 2.3 In-flight ids are projected via `gateway.get_document(id)` then deduped against the natural-sort page; pinned rows always carry `is_processing=True`
- [x] 2.4 Library router threads `settings: Settings = Depends(get_settings)` through the call
- [x] 2.5 Extracted the `/processing` GET into `_auto_tagger.fetch_processing_state` next to the existing `ping_auto_tagger` — two callers want it (library service + `documents/router.py::get_processing_state` could later migrate; left as-is for this change to keep the diff scoped)
- [x] 2.6 Five new test cases in `test_library_router.py`: page-1 pin happy path, page-1 dedup against natural sort, page-2 no /processing call (asserted via respx `.called`), 5xx fallback to plain results, AUTO_TAGGER_URL empty short-circuit
- [x] 2.7 16/16 library tests pass (was 11; +5 pin cases)

## 3. Library frontend: sort dropdown + pinned-row spinner

- [x] 3.1 `LibrarySearch` extended with `ordering?: LibraryOrdering`; exported `LibraryOrdering` type + closed-enum validator from `router.tsx`; URL parsing falls unknown values back to `undefined`
- [x] 3.2 `LibraryItem` TS type gains `is_processing: boolean`
- [x] 3.3 Library page reads `search.ordering ?? "-created"`, passes to `useLibrary`; "Sortierung" `<select>` added inside the filter sidebar (alongside other knobs), navigates immediately on change, drops `ordering` from URL when selecting the default for clean URLs
- [x] 3.4 Library `Row` receives `inFlight = row.is_processing || isInFlight(row.id, processing.data)` so both server-pin AND client-side `/processing` polling drive the existing spinner
- [x] 3.5 `pnpm lint`: 2 pre-existing warnings unrelated. `pnpm build`: clean, Library chunk grew 17.83 → 18.48 kB

## 4. Live verification

- [x] 4.1 Rebuilt all three services cleanly
- [x] 4.2 Routing-reason path verified via the new test matrix; the live reprocess + log-grep is deferred to user verification on a real Rechnung upload (the user said they'll test on the other machine)
- [x] 4.3 Live API check: `GET /api/library/?ordering=title&page_size=5` returns alphabetically-sorted rows (`'20260130-…' < 'Adobe Scan' < 'Angebot' < 'anwendungs…'`) — sort dropdown wire end-to-end works. SPA build emits the dropdown.
- [x] 4.4 Live API check: openapi schema now lists `is_processing` on `LibraryItem`. Pin behaviour verified by unit tests (5 cases); live "watch a doc pin to row 1" deferred to user verification with a real upload.

## 5. Documentation cadence

- [x] 5.1 CLAUDE.md gotchas row added: enumerates the four `reason=` values and what each means / how to react
- [x] 5.2 Library row in "What's implemented vs planned" extended with Sortierung + in-flight pin details
- [x] 5.3 Session note appended to `docs/sessions/2026-05-17.md` as a fourth pass; also captures the postponed duplicate-flagging plan
- [x] 5.4 `openspec status --change "library-ux-improvements"` shows 4/4 artifacts done; archive deferred per `aktenraum-commit-discipline`
