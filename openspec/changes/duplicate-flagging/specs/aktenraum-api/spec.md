## ADDED Requirements

### Requirement: aktenraum-api exposes ai-duplicate as a Library badge tag

The `_BADGE_TAGS` set in `aktenraum_api.library.service` SHALL include `ai-duplicate` so the SPA renders a colored pill on docs carrying the tag. The `_INTERNAL_TAGS` set MUST NOT include `ai-duplicate` — the tag is meant to be reachable as a user-facing filter (`GET /api/library/?tags=ai-duplicate`), distinct from the internal lifecycle vocabulary.

#### Scenario: Library row exposes the duplicate tag in `lifecycle_tags`
- **WHEN** `GET /api/library/` returns a row for a doc tagged `ai-duplicate` and `ai-propagated`
- **THEN** the row's `lifecycle_tags` array contains both `"ai-duplicate"` and `"ai-propagated"`

#### Scenario: User can filter Library by ai-duplicate
- **WHEN** `GET /api/library/?tags=ai-duplicate` is called
- **THEN** the response contains every non-pending doc tagged `ai-duplicate` (subject to the existing pagination and other filters)

#### Scenario: ai-duplicate is not stripped from the user tag chip vocabulary
- **WHEN** `GET /api/library/tags` is called and a propagated doc carries `ai-duplicate`
- **THEN** the response includes `ai-duplicate` as a tag the user can filter on (it is NOT classified as internal)
