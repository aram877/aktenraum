## Why

Paperless dedupes byte-identical re-uploads via SHA1 — that part is solved. The case the user hits in practice is "same content, different bytes": the same Vodafone bill scanned twice on different days, the same invoice as email-PDF plus a phone-camera scan, a re-saved PDF that picked up a different timestamp. Today these slip past Paperless's hash and into the AI pipeline as two independent documents; the user only spots them later by accident when filtering the Library and seeing two near-identical Rechnungen from the same correspondent on the same date.

The previous session's plan for `library-ux-improvements` postponed this as a separate change. The user's scoping decision was tight:

- **Detection method**: field-based only (no text similarity or embeddings in v1).
- **Trigger**: auto on propagation (no manual command, no backfill script in v1).
- **User actions**: flag-only — no new "Mögliche Duplikate" view, no compare-and-delete UI, no dismissal database. The user filters the Library by the `ai-duplicate` tag (using the existing tag-filter UI) and resolves duplicates via the existing Löschen / Papierkorb flow.

This is the minimum viable signal. Once the user has run it for a while on real intake, the data point "what false positives / false negatives did I see" is what decides whether to add text similarity, embeddings, or a dismissal store in v2.

## What Changes

- **New `ai-duplicate` auxiliary tag** registered in `packages/aktenraum-core/src/aktenraum_core/paperless/client.py` alongside the existing aux tags (`ai-auto-approved`, `ai-low-confidence`). NOT a lifecycle tag — it does not gate any state machine; it is a persistent marker on docs that might be duplicates of another doc in the corpus. Added to `bootstrap-paperless.sh` so a fresh install creates it. Added to `_BADGE_TAGS` in `aktenraum_api/library/service.py` so the SPA can render a duplicate pill.
- **New duplicate-detection module** at `services/auto-tagger/src/auto_tagger/dedup.py`. Single public function `find_duplicates(new_doc, candidates) -> list[int]` that returns ids of likely duplicates given the new doc's AI fields and a candidate corpus to scan. Strategy:
  - Compare by correspondent name (case-folded, trimmed) first — only docs sharing the same correspondent are real candidates, which keeps the scan O(C) where C is the number of docs from that correspondent.
  - Within the same-correspondent set, flag a match when AT LEAST ONE of the following pairs is true:
    - Same `ai_issue_date` AND same `ai_monetary_amount` (within 1 cent tolerance after normalisation), OR
    - At least one shared `ai_reference_numbers` entry (case-folded).
  - Skip the new doc itself (id equality).
  - Skip the comparison entirely when the new doc has no correspondent OR no `ai_issue_date` — without those anchors the false-positive rate is too high.
- **Propagator integration**: `services/auto-tagger/src/auto_tagger/propagator.py` calls the detector after a successful propagation. If the detector returns a non-empty list, the propagator adds `ai-duplicate` to BOTH the newly-propagated doc AND each matched candidate (idempotent — adding the tag twice is a no-op). Logs `duplicate_detected new_doc_id=… matches=[…] reason=…` for observability.
- **No SPA route changes, no new endpoints**. The user filters Library by the existing `?tags=ai-duplicate` URL state, sees flagged rows in the existing table view, and uses the existing Löschen / Papierkorb flow on the ones they decide are real duplicates. The `ai-duplicate` badge appears on flagged rows because it's in `_BADGE_TAGS`.
- **Tests**:
  - Unit tests for `find_duplicates` covering: exact field match → flag; mismatched correspondent → no flag; missing issue date → no flag; matching reference number without amount → flag; amount within tolerance → flag; amount outside tolerance → no flag; self-id excluded; multiple matches.
  - Integration test against `process_approved_document` with a fake Paperless: two docs with overlapping fields → both end up with `ai-duplicate` tagged.

## Capabilities

### New Capabilities
None. Duplicate detection is an extension of the existing `auto-tagger` propagation behaviour; no new user-visible service or domain.

### Modified Capabilities
- `auto-tagger`: new requirement — after a successful propagation, scan the propagated corpus for likely duplicates and tag both members of any match with the new `ai-duplicate` auxiliary tag.
- `aktenraum-api`: the `ai-duplicate` tag joins the badge vocabulary returned by `GET /api/library/` so the SPA can render a duplicate marker.

## Impact

- **Code (backend)**:
  - `packages/aktenraum-core/src/aktenraum_core/paperless/client.py` — document `ai-duplicate` next to the existing aux tags.
  - `services/auto-tagger/src/auto_tagger/dedup.py` — new module with the detector.
  - `services/auto-tagger/src/auto_tagger/propagator.py` — wire detection in after successful propagation.
  - `services/auto-tagger/tests/test_dedup.py` — new unit-test suite for the detector.
  - `services/auto-tagger/tests/test_propagator.py` — extend with the integration case.
  - `services/aktenraum-api/src/aktenraum_api/library/service.py` — `_BADGE_TAGS` includes `ai-duplicate`; `_INTERNAL_TAGS` does NOT (so the tag CAN be requested by the user as a Library filter).
- **Bootstrap**:
  - `scripts/bootstrap-paperless.sh` — `ensure_tag "ai-duplicate" "#a855f7"` (purple, distinct from the green/blue/red lifecycle palette).
- **Docs**:
  - `CLAUDE.md` — new row in "What's implemented vs planned"; new gotcha about "if you un-tag `ai-duplicate` on a doc, the next propagation that matches it will re-tag (v1 has no dismissal store)".
  - Session note when shipped.
- **Out of scope** (intentionally — defer to v2 if the corpus shows the gap):
  - Text-similarity (Jaccard / shingle / MinHash) for OCR-drifted duplicates.
  - Semantic-embedding cosine for fuzzy matches.
  - A backfill script that scans the existing corpus.
  - A dedicated "Mögliche Duplikate" SPA view.
  - A dismissal database — i.e. "this pair is NOT a duplicate, never flag it again".
  - Auto-deletion of detected duplicates (too risky without a dismissal store).
