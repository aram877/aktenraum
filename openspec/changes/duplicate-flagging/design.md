## Context

The user's scoping decision narrowed an otherwise broad design space to its smallest viable surface:

- Detection is **field-based only**. No text similarity, no embeddings. The signal is the AI fields the auto-tagger already extracts: `ai_correspondent`, `ai_issue_date`, `ai_monetary_amount`, `ai_reference_numbers`.
- Trigger is **auto on propagation**. The propagator already runs once per `ai-approved → ai-propagated` transition; piggyback on that single moment so the detection can never re-fire on the same doc twice.
- The user **does not want a new view, endpoint, or compare-and-resolve flow** in v1. Just flag candidates so they can find them by filtering the Library by tag and resolve via the existing Löschen flow.

This change is intentionally smaller than `library-ux-improvements` or `web-trash-management`. The unit of work is one detector module + one propagator hook + one tag bootstrap line. The design questions are about (a) the precision/recall trade-off of the field-based rule, and (b) what to do when fields are partially missing.

## Goals / Non-Goals

**Goals:**
- After a doc is propagated, any other propagated doc with the same correspondent, the same issue date, and matching monetary amount (within 1 cent) OR overlapping reference numbers is tagged `ai-duplicate`. Both members of the pair carry the tag.
- The detection is cheap enough to run inline in the propagator without measurably extending propagation latency (the user already feels approve→propagated as instant after `code-review-cleanups`).
- The tag shows up as a colored badge in the Library list so the user can spot it at a glance, and is filterable so the user can pull a "show me everything that might be a duplicate" view.
- The detection is **idempotent** — running again on the same doc/corpus state never produces extra tags.

**Non-Goals:**
- Catching OCR-drifted duplicates (different date or different amount because OCR fragmented "28.02.24" → "2 8.02.24"). The known false negative is documented; if it shows up in the user's real corpus, that's the data point for v2.
- Dismissals — recording "the user looked at these two and confirmed they are NOT duplicates". v1 has no such store. The user can manually un-tag a doc in Paperless to remove the badge; the NEXT time the detector runs against that doc (because a new doc arrives that also matches), it will re-tag both. This is acceptable for v1 because the user's intent is "flag obvious duplicates"; the long tail of disputed pairs is v2 territory.
- Clustering / linking — knowing which docs are in the same duplicate cluster. v1 only carries a binary "yes/no flag"; the user works out the pairs by sorting / filtering. v2 might add a per-pair custom field linking `ai_duplicate_of`.
- A backfill script for the existing corpus. v1 catches duplicates among NEW propagations against the existing propagated set; the user's existing already-propagated corpus is not re-scanned. The backfill is a one-line follow-up if needed.

## Decisions

### 1. The matching rule: same correspondent + (same issue_date AND same amount) OR shared reference number

Concretely, two docs A and B are duplicates when ALL of:

1. `A.ai_correspondent` exists, equals `B.ai_correspondent` after lower-case + trim.
2. `A.ai_issue_date` exists and equals `B.ai_issue_date` (strict ISO).
3. At least one of:
   - `A.ai_monetary_amount` and `B.ai_monetary_amount` exist and the amounts differ by ≤ 0.01 EUR after currency-code strip + numeric parse (the gateway already stores `EUR123.45` ISO format).
   - The intersection of `A.ai_reference_numbers` and `B.ai_reference_numbers` (split by comma, lower-cased, trimmed) is non-empty.

Alternatives considered:

- **Title equality** (`ai_title` or Paperless `title`). Rejected: titles are LLM-generated and can vary between runs; "Vodafone Rechnung Februar 2024" and "Rechnung von Vodafone (Feb 24)" describe the same thing but won't match.
- **Just correspondent + date**. Rejected as too loose: a user with three Edeka receipts on a Saturday would have all three flagged. The amount or reference-number anchor is what makes the signal meaningful.
- **Just correspondent + amount** (no date). Rejected: a recurring Vodafone bill at the same amount every month would self-flag.
- **Correspondent + date + amount, AND reference-number overlap**, both required. Rejected as too tight: many German Rechnungen don't carry stable reference numbers in the OCR (or the LLM doesn't extract them), and the date+amount pair alone is already high-precision.

### 2. What to do when fields are missing

If the new doc lacks `ai_correspondent` OR `ai_issue_date`, **skip detection entirely** — return `[]`. Without those anchors the false-positive rate climbs (any doc with the same monetary amount becomes a candidate). The cost of skipping is missing the detection on poorly-extracted docs; the cost of running anyway is bogus flags that erode user trust.

When the matched candidate lacks the same fields, the per-field check returns false and the candidate is dropped naturally — no special-casing needed.

### 3. Where the detector lives

`services/auto-tagger/src/auto_tagger/dedup.py`. Pure functions, no Paperless I/O — takes a "new doc fields" struct and a list of "candidate doc fields" structs, returns a list of candidate ids. The propagator does the Paperless GETs and feeds the result. This keeps the detector unit-testable without HTTP mocks.

Alternatives:

- **`aktenraum_core/dedup/`** — promote to the shared package. Rejected for now: only one caller. Promote on the second caller (e.g. a backfill script in v2).
- **Run detection inside the gateway** — keeps a single source of truth for the Paperless calls but couples the gateway to a feature-specific decision. Rejected: dedup is feature logic, gateway stays domain-thin.

### 4. How the propagator queries candidates

Reuse the existing `gateway.get_documents_with_tag("ai-propagated", batch_size=…)` pattern but filter to the new doc's correspondent. Two options:

- (a) Paperless's `correspondent__id=` filter on `/api/documents/`, AND `tags__id__all=<ai-propagated-id>`. One round-trip, server-side filtering. Cost: a Paperless GET per propagation. For a typical correspondent (Vodafone, Telekom, …) returns ≤ 100 rows in personal-DMS scale.
- (b) Fetch ALL propagated docs once and filter Python-side. Rejected: scales worse and the Paperless query is cheap.

We use (a). Cap the returned candidates at 200 docs per correspondent (`batch_size=200`) to bound memory if the user has a heavy correspondent like a bank with 1000 Kontoauszug rows; the detector still finds the most-recent matches because Paperless's default ordering is `-created`.

### 5. Tagging both members

The propagator already calls `swap_lifecycle_tag(doc_id, remove=["ai-approved"], add=["ai-propagated"])` for the new doc. After detection returns `[]` or matches:

- If matches exist, add `ai-duplicate` to BOTH the new doc and each matched id. Each PATCH is independent and idempotent — adding a tag that's already there is a no-op on Paperless's side.
- The new-doc tagging happens in the same `swap_lifecycle_tag` call by appending `ai-duplicate` to the `add` list (one PATCH instead of two).
- Each matched doc gets its own PATCH via the gateway's existing `add_tag_to_document(id, "ai-duplicate")` helper (which is also idempotent).

Failure handling: a failed `ai-duplicate` PATCH does NOT fail the propagation. Log `duplicate_tag_failed` at warning level and move on; the doc lands as `ai-propagated` correctly and the detector will re-flag on the next propagation against this correspondent.

### 6. `_BADGE_TAGS` membership

`ai-duplicate` goes into `_BADGE_TAGS` in `aktenraum_api/library/service.py` so the SPA renders a pill. It does NOT go into `_INTERNAL_TAGS` (the set that gets stripped from the user-facing tag-chip vocabulary). The reason: the user explicitly WANTS to filter Library by `?tags=ai-duplicate`, so the tag needs to be in the requestable vocabulary. `_INTERNAL_TAGS` is for tags the user shouldn't reach directly.

This is intentional asymmetry with `ai-auto-approved`, which is both badge AND internal — the user never filters by auto-approved.

## Risks / Trade-offs

- **[OCR drift breaks the date-or-amount match]** → Mitigation: documented as known limitation. v2 lever is text similarity. Until then the user manually catches drift cases by browsing the Library; the detector catches the bulk of obvious cases without false-positive cost.
- **[Recurring same-amount-same-day bills (e.g. two Edeka receipts on the same Saturday)]** → Mitigation: the rule requires same amount AND same date — recurring different-amount bills don't trigger. Two coincidentally-same-amount-same-day docs do trigger; the user can untag manually. Cost is one extra click.
- **[User untag is futile because new propagation re-tags]** → Mitigation: documented in CLAUDE.md gotchas. v2 lever is the dismissal store. The user can also delete the duplicate (the kept doc still carries the tag, but with no remaining match it's just a stale flag — harmless).
- **[Detection adds N Paperless GETs to every propagation]** → Mitigation: one GET (the correspondent-filtered query). Cost in the milliseconds range; the propagator already does multiple GETs (the existing entity lookups) so the marginal cost is negligible.
- **[A propagated doc whose correspondent is renamed in Paperless later]** → Mitigation: detection runs at the moment of propagation, against the correspondent name as it was then. Subsequent renames don't retro-flag. Acceptable — the user can manually re-trigger detection on a doc by reprocessing it (which clears lifecycle tags and re-runs the whole pipeline including detection).

## Migration Plan

1. **Bootstrap tag** — add `ensure_tag "ai-duplicate" "#a855f7"` to `scripts/bootstrap-paperless.sh` and run the script against the live install. Idempotent: no-op on second run.
2. **Detector module + tests** — pure unit tests, no live calls. Run `uv run pytest services/auto-tagger/tests/test_dedup.py`.
3. **Propagator integration + integration test** — fakes against the existing `process_approved_document` test harness. Run `uv run pytest services/auto-tagger/tests/test_propagator.py`.
4. **Library badge** — `_BADGE_TAGS` change + verify library tests pass.
5. **`task tagger:rebuild` + `task api:rebuild`**. Recreate both services.
6. **Live smoke**: trigger a reprocess on a doc that has a known duplicate. Watch `docker compose logs auto-tagger` for `duplicate_detected`. Open `/library?tags=ai-duplicate` to see flagged rows.
7. **CLAUDE.md + session note**.

Rollback is a plain revert per commit. No data migration; un-tagging in Paperless is also a clean rollback.

## Open Questions

- The 0.01 EUR amount tolerance is arbitrary. Currencies that aren't EUR (none today, but the data model technically supports any ISO code) would need a per-currency tolerance. Defer — current corpus is EUR-only.
- Whether `ai_reference_numbers` overlap should require ≥ 2 shared entries when both lists are long (right now: 1 is enough). Lean keep at 1: reference numbers are designed to be unique anchors, so any overlap is signal. Resolve in PR review if it produces obvious false positives.
- Whether to also flag pairs where amounts AND reference numbers BOTH match (the strongest signal). Today we OR the two; ANDing tightens precision but the OR catches the German Rechnung case where the LLM extracts the amount but not the Rechnungsnr. — and vice versa. Keep OR.
