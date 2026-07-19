## ADDED Requirements

### Requirement: aktenraum-api pins actively-processed documents to page 1 of GET /api/library/

When `GET /api/library/` is called with `page=1` (the default), the service SHALL fetch the auto-tagger's `/processing` endpoint (best-effort, 2-second timeout, `X-Aktenraum-Secret` header when `WEBHOOK_SECRET` is configured) to determine which documents are currently being worked on by the extraction, propagation, or indexer workers. Those documents' rows SHALL be projected via the library row shape and prepended to the page-1 `results` list. Natural-sort rows whose id is in the in-flight set SHALL be filtered out of the page-1 list so the row appears exactly once.

When `page >= 2`, the endpoint MUST NOT call the auto-tagger and MUST return the natural-sort page exactly as it did before this change.

The endpoint MUST return successfully when the auto-tagger is unreachable, mis-configured, or returns a non-2xx response — the page-1 prepend silently degrades to plain natural-sort results and the failure is logged at `info`/`warning` level (matching the existing `/api/documents/processing` reachability pattern).

#### Scenario: Page 1 prepends one in-flight doc above the natural sort
- **WHEN** a Rechnung doc id 42 is currently in the extraction slot, the natural-sort page-1 would have rows `[10, 11, 12, …]` not including 42, and the SPA requests `GET /api/library/?page=1`
- **THEN** the response `results` array starts with the row for doc 42 (carrying `is_processing=true`), followed by `[10, 11, 12, …]`

#### Scenario: Page 1 dedupes when the in-flight doc would naturally appear on this page
- **WHEN** doc id 11 is in the propagation slot AND its natural-sort position is row 4 of page 1
- **THEN** the response `results` array has doc 11 as the first row (with `is_processing=true`) and NOT in row 4; the page is one row shorter than the natural sort would produce

#### Scenario: Page 2+ is unchanged
- **WHEN** `GET /api/library/?page=2` is called with one in-flight doc
- **THEN** the response is the plain natural-sort page 2 with no prepended rows, no in-flight HTTP call to the auto-tagger, and no `is_processing` flags set on any row

#### Scenario: Auto-tagger unreachable does not fail the library
- **WHEN** the auto-tagger HTTP listener is down at the moment of the page-1 fetch
- **THEN** the response is the plain natural-sort page 1 (no prepend, no `is_processing` flags) and the API logs the unreachability at `info` or `warning` level

### Requirement: LibraryItem exposes an is_processing flag

The `LibraryItem` Pydantic model returned by `GET /api/library/` SHALL include a boolean field `is_processing` (default `false`). The field is set to `true` ONLY on rows that the page-1 prepend logic projected from the auto-tagger's `/processing` endpoint. Natural-sort rows always have `is_processing=false`.

#### Scenario: Pinned rows expose the flag
- **WHEN** the response includes a page-1 prepended in-flight row
- **THEN** that row's JSON body has `"is_processing": true`

#### Scenario: Natural-sort rows do not expose the flag
- **WHEN** the response includes a row from the natural-sort page (whether page 1 or 2+)
- **THEN** that row's JSON body has `"is_processing": false`

### Requirement: aktenraum-api honours the ordering query param on GET /api/library/

`GET /api/library/` SHALL accept an `ordering` query parameter from the existing allowlist `{-created, created, -modified, modified, title, -title}` (default `-created`). Unknown values SHALL fall back to the default rather than 4xx. The ordering MUST apply only to the natural-sort portion of the page; pinned in-flight rows always appear first regardless of `ordering`.

#### Scenario: Ordering by title sorts natural-sort rows A→Z
- **WHEN** `GET /api/library/?ordering=title` is called and no doc is in-flight
- **THEN** the response `results` are sorted ascending by title

#### Scenario: Pinned rows ignore the sort
- **WHEN** `GET /api/library/?ordering=title` is called and one doc is in-flight
- **THEN** the in-flight row is the first element of `results` (regardless of title), followed by the natural-sort rows in title-ascending order
