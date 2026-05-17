## ADDED Requirements

### Requirement: Auto-tagger detects likely duplicates on propagation

After a successful propagation (`ai-approved → ai-propagated`), the auto-tagger SHALL scan the existing propagated corpus for likely duplicates of the newly-propagated document and tag both members of every matching pair with `ai-duplicate`. The scan SHALL be filtered to documents that share the new doc's `ai_correspondent` to bound the work; the detector SHALL apply a deterministic field-equality rule to identify duplicate candidates within that set.

Two docs A and B count as duplicates when ALL of the following are true:
- Both have a non-empty `ai_correspondent`, equal after Unicode-case-folding and whitespace-trimming.
- Both have an `ai_issue_date`, equal as strict ISO date strings.
- At least one of:
  - Both have an `ai_monetary_amount`, and the numeric values differ by ≤ 0.01 after stripping the ISO currency code prefix.
  - The lower-cased intersection of `ai_reference_numbers` (comma-separated, trimmed) between A and B is non-empty.

Detection SHALL skip the new doc itself (by id equality) when scanning the candidate set.

#### Scenario: Two propagated Rechnungen from the same correspondent with matching date and amount are both tagged
- **WHEN** doc A (correspondent="Telekom", ai_issue_date="2024-03-15", ai_monetary_amount="EUR42.99") is already propagated and doc B (same correspondent, same date, ai_monetary_amount="EUR42.99") is freshly propagated
- **THEN** the auto-tagger PATCHes `ai-duplicate` onto both A and B; subsequent `GET /api/documents/{a_id}/` and `GET /api/documents/{b_id}/` show the tag in their tag lists

#### Scenario: Different correspondents with matching date and amount are NOT flagged
- **WHEN** doc A (correspondent="Telekom") and doc B (correspondent="Vodafone") share the same `ai_issue_date` and `ai_monetary_amount`
- **THEN** neither doc receives the `ai-duplicate` tag

#### Scenario: Reference-number overlap alone is enough
- **WHEN** doc A and doc B share correspondent, share `ai_issue_date`, have NO monetary amount, and `ai_reference_numbers` contains "RN-12345" on both
- **THEN** both docs are tagged `ai-duplicate`

#### Scenario: Missing issue_date skips detection
- **WHEN** the freshly-propagated doc has no `ai_issue_date`
- **THEN** the detector returns an empty list and no `ai-duplicate` tags are written, regardless of how many candidates exist

#### Scenario: Missing correspondent skips detection
- **WHEN** the freshly-propagated doc has no `ai_correspondent`
- **THEN** the detector returns an empty list and no `ai-duplicate` tags are written

#### Scenario: Detection is idempotent on re-run
- **WHEN** the propagator re-runs on a doc that already carries `ai-duplicate`
- **THEN** no spurious tags are added (the PATCH is a no-op) and the doc keeps exactly one `ai-duplicate` tag entry

#### Scenario: Failure to tag a matched candidate does not fail propagation
- **WHEN** Paperless returns 5xx on the `add_tag_to_document(matched_id, "ai-duplicate")` PATCH
- **THEN** the new doc's propagation completes successfully, `duplicate_tag_failed` is logged at warning level with the matched id, and the doc is still tagged `ai-propagated`

### Requirement: ai-duplicate is registered as an auxiliary tag

The `ai-duplicate` tag SHALL be created by `scripts/bootstrap-paperless.sh` on a fresh install. It SHALL NOT be part of the `LIFECYCLE_TAGS` tuple in `aktenraum_core.paperless.client` (it is not a lifecycle state — it is an auxiliary marker that persists alongside any lifecycle state). The propagator SHALL not strip it when transitioning a doc's lifecycle state.

#### Scenario: Fresh install creates the tag
- **WHEN** `bash scripts/bootstrap-paperless.sh` is run against an install with no `ai-duplicate` tag
- **THEN** the tag exists in Paperless after the script completes with color `#a855f7`

#### Scenario: Re-running the bootstrap is a no-op
- **WHEN** `bash scripts/bootstrap-paperless.sh` is run twice
- **THEN** there is exactly one `ai-duplicate` tag in Paperless after both runs
