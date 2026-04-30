## ADDED Requirements

### Requirement: aktenraum-api exposes a natural-language search endpoint at /api/ai/ask

The service SHALL expose `POST /api/ai/ask`, auth-gated by the same cookie as the rest of the SPA-facing API. The request body SHALL be either `{"query": str}` or `{"filter": SearchFilter}`. Exactly one of the two SHALL be present; otherwise the response is HTTP 422.

The response on success SHALL be HTTP 200 with body shape:

```json
{
  "filter": { ...SearchFilter... },
  "results": [ { "id": int, "title": str, "correspondent": str|null, "document_type": str|null, "created": "YYYY-MM-DD", "monetary_amount": str|null } ],
  "explanation": str,
  "total": int
}
```

`explanation` SHALL be a one-sentence German summary of how the filter was understood, prefixed with "Ich habe verstanden:".

#### Scenario: Unauthenticated call returns 401

- **WHEN** `POST /api/ai/ask` is called without the `aktenraum_session` cookie
- **THEN** the response is HTTP 401 with no body fields beyond `detail`

#### Scenario: Free-text query path invokes the LLM and returns a filter + results

- **WHEN** an authenticated `POST /api/ai/ask` is called with `{"query": "Lohnabrechnungen aus 2023"}`
- **THEN** the API builds a German prompt including the 20-value document-type taxonomy and the live correspondent list, calls the configured LLM backend, validates the response against `SearchFilter`, translates it to a Paperless query, and returns HTTP 200 with `filter`, `results`, `explanation`, and `total`

#### Scenario: Filter-only path skips the LLM

- **WHEN** an authenticated `POST /api/ai/ask` is called with `{"filter": {"document_type": "Gehaltsabrechnung", "date_from": "2023-01-01", "date_to": "2023-12-31"}}`
- **THEN** the API skips the LLM call entirely, translates the supplied filter directly into a Paperless query, and returns HTTP 200 with the same response shape

#### Scenario: Paperless token unset returns 503

- **WHEN** `POST /api/ai/ask` is called against a service whose `PAPERLESS_API_TOKEN` is unset or empty
- **THEN** the response is HTTP 503 with `detail` mentioning the missing token, while `/api/health` and `/api/auth/*` continue to respond normally

#### Scenario: LLM emits an invalid filter returns 422

- **WHEN** the LLM backend returns JSON that fails `SearchFilter` validation (e.g. unknown `document_type`)
- **THEN** the API returns HTTP 422 with the Pydantic validation error in `detail`

#### Scenario: Both query and filter omitted returns 422

- **WHEN** `POST /api/ai/ask` is called with `{}` or `{"query": null, "filter": null}`
- **THEN** the response is HTTP 422 with `detail` indicating exactly one of `query` or `filter` is required

### Requirement: aktenraum-api's SearchFilter constrains LLM output to a closed enum

`SearchFilter` SHALL define:

- `document_type: DocumentType | None` — closed enum reusing the 20-value taxonomy from `aktenraum-core`.
- `correspondent: str | None`
- `date_from: date | None`, `date_to: date | None`
- `min_amount: float | None`, `max_amount: float | None`
- `text: str | None`

All fields SHALL be optional individually; an empty filter is valid (returns the most-recent documents). String values SHALL strip whitespace; dates SHALL serialise as ISO `YYYY-MM-DD`.

#### Scenario: Unknown document type fails validation

- **WHEN** a filter is constructed with `document_type="Banane"`
- **THEN** Pydantic validation raises `ValidationError` and the value is not coerced

#### Scenario: Empty filter is valid

- **WHEN** a filter is constructed with no fields set
- **THEN** validation succeeds and translation produces an empty Paperless query (broadest search)

### Requirement: aktenraum-api translates SearchFilter to Paperless query parameters

A pure function `filter_to_paperless_params(f, *, correspondent_id, document_type_id) -> dict` SHALL map:

- `document_type` → `document_type=<id>`
- `correspondent` → `correspondent=<id>`
- `date_from` → `created__date__gte=<YYYY-MM-DD>`
- `date_to` → `created__date__lte=<YYYY-MM-DD>`
- `text` → `query=<text>`

The function SHALL NOT translate `min_amount` / `max_amount` into query params; those SHALL be applied post-fetch by `apply_post_filter(...)`.

#### Scenario: All native fields translate to query params

- **WHEN** `filter_to_paperless_params` is called with `document_type=Gehaltsabrechnung` (id 5), `correspondent="Telekom"` (id 12), `date_from=2023-01-01`, `date_to=2023-12-31`, `text="bonus"`
- **THEN** the returned dict equals `{"document_type": 5, "correspondent": 12, "created__date__gte": "2023-01-01", "created__date__lte": "2023-12-31", "query": "bonus"}`

#### Scenario: Amount fields are not translated to query params

- **WHEN** `filter_to_paperless_params` is called with only `min_amount=3000`
- **THEN** the returned dict is empty

#### Scenario: Unknown correspondent name resolves to id=None

- **WHEN** the input filter has a correspondent name with no matching id
- **THEN** `correspondent` is omitted from the params (broader search) and the name is appended to `text` as a fallback

### Requirement: aktenraum-api applies amount post-filtering against the ai_monetary_amount custom field

A pure function `apply_post_filter(results, f, *, name_by_id) -> list[DocumentSummary]` SHALL:

1. Read each result's `ai_monetary_amount` custom field, parsing it from the Paperless `<ISO><amount>` (e.g. `EUR149.99`) or German `<amount> <ISO>` formats.
2. Drop results outside `[min_amount, max_amount]` if either bound is set.
3. When an amount bound is set, drop results that have no `ai_monetary_amount` value (rather than retaining unknowns).
4. Project the surviving results into `DocumentSummary`.

#### Scenario: min_amount drops cheaper documents

- **WHEN** `apply_post_filter` runs with `min_amount=3000` against three results with amounts `1500`, `3000`, `4500`
- **THEN** the returned list has exactly the latter two

#### Scenario: max_amount drops expensive documents and unknown amounts

- **WHEN** `apply_post_filter` runs with `max_amount=100` against four results with amounts `50`, `99`, `200`, and one missing the field entirely
- **THEN** the returned list has exactly the first two

#### Scenario: No amount bounds keeps unknowns

- **WHEN** `apply_post_filter` runs with `min_amount=None` and `max_amount=None`
- **THEN** all input results are projected to `DocumentSummary` regardless of whether they have an amount

### Requirement: aktenraum-api's prompt includes the document type enum, live correspondents, and few-shot examples

`build_messages(query, *, correspondents)` SHALL produce a `list[dict]` of role/content messages. The system message SHALL include:

- All 20 document types from `aktenraum_core.models.DocumentType`
- A comma-separated list of correspondent names (capped at 200 if more)
- Explicit date-parsing rules (year-only → full year, "Q1 …" → quarter range, German month names)
- At least four `Beispiel:` exemplars covering year+type, correspondent, amount, and noisy/mixed queries

The user message SHALL be the raw query verbatim.

#### Scenario: Prompt enumerates every document type

- **WHEN** `build_messages("test", correspondents=[])` is called
- **THEN** the rendered system message contains each of the 20 enum values

#### Scenario: Prompt includes the live correspondents

- **WHEN** `build_messages("test", correspondents=["Telekom", "Stadtwerke München"])` is called
- **THEN** the rendered system message lists both names, comma-separated, under a "Bekannte Korrespondenten" heading

#### Scenario: Prompt caps very large correspondent lists

- **WHEN** `build_messages("test", correspondents=[f"Corr-{i}" for i in range(500)])` is called
- **THEN** the rendered prompt contains exactly 200 correspondent names

### Requirement: aktenraum-api proxies Paperless calls server-side, never exposing the API token to the SPA

A `PaperlessGateway` class SHALL hold the API token and base URL, sign every Paperless request with `Authorization: Token <token>`, and expose only the operations needed by the AI features (`list_correspondents`, `list_document_types`, `search_documents`). The token SHALL be loaded from `PAPERLESS_API_TOKEN` env var. The token value SHALL NOT appear in any response body, log line, or error detail returned over HTTP.

#### Scenario: Search proxies through the gateway with the token attached

- **WHEN** `aktenraum-api` handles `/api/ai/ask` and reaches the search step
- **THEN** the Paperless HTTP request is sent with `Authorization: Token <PAPERLESS_API_TOKEN>` and the SPA's response contains no `Authorization` header information

#### Scenario: Token never leaks into error bodies

- **WHEN** Paperless returns 401 to the gateway
- **THEN** the API returns 502 with `detail="Paperless rejected the API token"` (or equivalent), without including the raw token in the response or in structured logs

### Requirement: aktenraum-api caches the correspondent list per process with a TTL

The gateway SHALL cache the `{name: id}` map for `CORRESPONDENT_LIST_TTL_SECONDS` (default 300) to avoid hitting Paperless on every `/api/ai/ask` call. Cache keys are the gateway instance; cache eviction is purely time-based.

#### Scenario: Second call within TTL hits the cache

- **WHEN** `list_correspondents` is called twice within the TTL window
- **THEN** the second call returns the cached value without an HTTP request to Paperless

#### Scenario: Call after TTL refreshes the cache

- **WHEN** `list_correspondents` is called once, the simulated clock advances past the TTL, and it is called again
- **THEN** the second call hits Paperless and updates the cache

### Requirement: aktenraum-api emits a German explanation derived from the SearchFilter

A pure function `explain_filter(f) -> str` SHALL produce a German one-sentence summary of the populated fields, prefixed with "Ich habe verstanden:". An empty filter SHALL yield "Ich habe verstanden: keine Einschränkungen.".

#### Scenario: Multi-field filter renders a German sentence

- **WHEN** `explain_filter(SearchFilter(document_type=DocumentType.Gehaltsabrechnung, date_from=date(2023,1,1), date_to=date(2023,12,31)))` is called
- **THEN** the return value contains "Gehaltsabrechnung" and the year "2023" and starts with "Ich habe verstanden:"

#### Scenario: Empty filter produces a clear default

- **WHEN** `explain_filter(SearchFilter())` is called
- **THEN** the return value is `"Ich habe verstanden: keine Einschränkungen."`
