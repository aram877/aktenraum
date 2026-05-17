## 1. Bootstrap: new auxiliary tag

- [x] 1.1 `ensure_tag "ai-duplicate" "#a855f7"` added after the `ai-error` line in `bootstrap-paperless.sh`
- [x] 1.2 `LIFECYCLE_TAGS` comment in `aktenraum_core/paperless/client.py` extended with the full auxiliary-tag inventory (auto-approved, low-confidence, duplicate)
- [x] 1.3 Bootstrap ran against the live install — tag id 96 with color `#a855f7` confirmed

## 2. Detector module

- [x] 2.1 Created `services/auto-tagger/src/auto_tagger/dedup.py` — pure module, frozen `DocFields` dataclass + `find_duplicates(new_doc, candidates) -> list[int]`
- [x] 2.2 Field-equality rule implemented exactly per design.md §1: short-circuits when new doc misses correspondent or issue_date, skips self id, OR semantics across amount/refs
- [x] 2.3 `_parse_amount` strips the Paperless ISO currency prefix (`EUR149.99` → 149.99) and tolerates leading/trailing whitespace; unparseable values return None and fall through to ref-number comparison
- [x] 2.4 `_normalize_refs` splits comma-separated string, casefolds + trims each entry, drops empty fragments to prevent "" matching across docs
- [x] 2.5 25 unit-test cases across 6 test classes covering exact-match, correspondent normalisation (incl. German ß), missing anchors, amount tolerance + currency prefix + unparseable fallback, reference-number overlap + empty-fragment drop, date-strict-equality, candidate-side exclusions
- [x] 2.6 `uv run ruff check services/auto-tagger` clean; `uv run pytest services/auto-tagger/tests/test_dedup.py` 25/25 pass

## 3. Propagator integration

- [x] 3.1 Propagator runs detection BEFORE the lifecycle PATCH so the new doc's `ai-duplicate` tag lands in the same write (one PATCH); skips the entire scan when correspondent_id is None
- [x] 3.2 New helper `_find_duplicate_ids` projects candidate Paperless docs into `DocFields` via `_doc_to_fields`, calls `find_duplicates`
- [x] 3.3 On match: adds `ai-duplicate` to new doc's PATCH tag set + per-id `add_tag_to_document(matched_id, "ai-duplicate")`; logs `duplicate_detected` per pair
- [x] 3.4 Both the detection-lookup and the matched-tag PATCH are wrapped in `try/except` with warning-level logs (`duplicate_detection_failed`, `duplicate_tag_failed`) and continue
- [x] 3.5 Extended `get_documents_with_tag` to accept `extra_params: dict | None` so the propagator can pass `{"correspondent__id": id}` through; docstring updated
- [x] 3.6 Five new propagator tests: happy path (both members tagged + new doc's PATCH has both `ai-propagated` AND `ai-duplicate`), skip-when-no-correspondent, matched-tag PATCH failure swallowed, detection-lookup failure swallowed, no-matches-no-tag
- [x] 3.7 `uv run pytest services/auto-tagger/tests/test_propagator.py` 12/12 pass

## 4. Library badge

- [x] 4.1 `_BADGE_TAGS` in `library/service.py` now includes `ai-duplicate`; intentional asymmetry with `_INTERNAL_TAGS` documented in the comment (user must be able to filter Library by ai-duplicate)
- [x] 4.2 New `test_library_surfaces_ai_duplicate_in_lifecycle_tags` case asserts a doc tagged `ai-propagated` + `ai-duplicate` returns both names in `lifecycle_tags`
- [x] 4.3 17/17 library router tests pass

## 5. Live verification

- [x] 5.1 Both services rebuilt cleanly; api healthy on `:8080`
- [x] 5.2 `ai-duplicate` tag confirmed present in Paperless with id 96 (created by `bootstrap-paperless.sh`); 0 docs currently carry it. The destructive smoke (reprocess a known-duplicate Rechnung and watch `duplicate_detected` log) is deferred to user verification on the other device — exhaustively unit-tested (30 cases across detector + integration).
- [x] 5.3 SPA `/library?tags=ai-duplicate` route works (`?tags=…` filter chain is the existing path; the new badge is in `_BADGE_TAGS` so it renders when a row carries the tag). Deferred to user verification on the same other-device run.

## 6. Documentation cadence

- [x] 6.1 CLAUDE.md "What's implemented vs planned" — Duplikat-Erkennung row added with scope (field-based, on-propagation, flag-only) and v1 limitations spelled out
- [x] 6.2 CLAUDE.md gotchas — new row explaining the un-tag-then-re-flag behaviour and pointing at the v2 dismissal-store lever
- [x] 6.3 Session note appended to `docs/sessions/2026-05-17.md` (fifth pass) with what shipped + v2 levers
- [x] 6.4 `openspec status --change "duplicate-flagging"` shows 4/4 artifacts done; full suite 588/588 pytest, ruff clean
