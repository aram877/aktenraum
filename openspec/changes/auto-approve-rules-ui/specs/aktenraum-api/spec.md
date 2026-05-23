## ADDED Requirements

### Requirement: Authenticated users can read the current set of auto-approve rules

The system SHALL expose `GET /api/settings/auto-approve` returning the full set of 26 auto-approve rules (one per `DocumentType` enum value). The endpoint MUST require a valid session cookie.

#### Scenario: Authenticated user reads the rule set

- **WHEN** a logged-in user GETs `/api/settings/auto-approve`
- **THEN** the server responds `200 OK` with a JSON body shaped `{rules: [{document_type, enabled, min_confidence, updated_at, updated_by}]}`
- **AND** the `rules` array contains exactly 26 entries, one per `DocumentType` enum value
- **AND** entries are sorted alphabetically by `document_type`
- **AND** `min_confidence` is a number in `[0.00, 1.00]` with 2-decimal precision
- **AND** `updated_by` is the username string or `null` (if never updated since seed)

#### Scenario: Unauthenticated request

- **WHEN** a client without a valid session cookie GETs `/api/settings/auto-approve`
- **THEN** the server responds `401 Unauthorized`

#### Scenario: Adding a new DocumentType expands the rule set on next API boot

- **WHEN** a new value is added to the `DocumentType` enum in `aktenraum-core` and the API is restarted
- **THEN** the lifespan reconciler inserts a row for the new type with `enabled=false`, `min_confidence=0.90`, `updated_by=null`
- **AND** subsequent `GET /api/settings/auto-approve` calls include the new row

### Requirement: Authenticated users can update the full set of auto-approve rules

The system SHALL expose `PUT /api/settings/auto-approve` accepting a full-set replacement payload covering all 26 `DocumentType` enum values. The endpoint MUST require a valid session cookie AND require the payload to contain exactly one entry per enum value.

#### Scenario: Valid full-set update

- **WHEN** an authenticated user PUTs `{rules: [<26 entries, one per DocumentType>]}` with `enabled` (bool) and `min_confidence` (number in [0.00, 1.00]) per entry
- **THEN** the server responds `200 OK` with the same shape as the GET response, reflecting the new state
- **AND** every row in the `auto_approve_rules` table is updated to match the payload
- **AND** `updated_at` on every updated row is set to the request time (UTC)
- **AND** `updated_by` on every updated row is set to the requesting user's username

#### Scenario: Payload omits a DocumentType

- **WHEN** an authenticated user PUTs `{rules: [<25 entries — Rechnung missing>]}`
- **THEN** the server responds `400 Bad Request` with a detail enumerating the missing `document_type` value(s)
- **AND** no rows in the `auto_approve_rules` table are modified

#### Scenario: Payload includes an unknown document_type

- **WHEN** an authenticated user PUTs an entry with `document_type="NichtImEnum"`
- **THEN** the server responds `422 Unprocessable Content` (Pydantic validation against the `DocumentType` enum)
- **AND** no rows are modified

#### Scenario: Payload includes a duplicate document_type

- **WHEN** an authenticated user PUTs two entries with `document_type="Rechnung"`
- **THEN** the server responds `400 Bad Request` with a detail naming the duplicated value
- **AND** no rows are modified

#### Scenario: min_confidence outside [0.00, 1.00]

- **WHEN** an authenticated user PUTs an entry with `min_confidence=1.5` or `min_confidence=-0.1`
- **THEN** the server responds `422 Unprocessable Content`
- **AND** no rows are modified

#### Scenario: Unauthenticated PUT

- **WHEN** a client without a valid session cookie PUTs `/api/settings/auto-approve`
- **THEN** the server responds `401 Unauthorized`
- **AND** no database write occurs

### Requirement: Internal endpoint exposes rules to the auto-tagger

The system SHALL expose `GET /api/internal/auto-approve-rules` that returns the same payload shape as `GET /api/settings/auto-approve`. The endpoint MUST validate an `X-Aktenraum-Secret` header against the `WEBHOOK_SECRET` env var when that var is set.

#### Scenario: Valid secret header

- **WHEN** the auto-tagger GETs `/api/internal/auto-approve-rules` with header `X-Aktenraum-Secret: <correct>`
- **THEN** the server responds `200 OK` with `{rules: [...]}` containing 26 entries
- **AND** no session cookie is required

#### Scenario: Missing secret header when WEBHOOK_SECRET is set

- **WHEN** a client GETs `/api/internal/auto-approve-rules` without the `X-Aktenraum-Secret` header
- **AND** the server's `WEBHOOK_SECRET` env var is non-empty
- **THEN** the server responds `401 Unauthorized`

#### Scenario: Wrong secret header when WEBHOOK_SECRET is set

- **WHEN** a client GETs `/api/internal/auto-approve-rules` with header `X-Aktenraum-Secret: <wrong>`
- **AND** the server's `WEBHOOK_SECRET` env var is non-empty
- **THEN** the server responds `401 Unauthorized`

#### Scenario: Secret disabled mode

- **WHEN** a client GETs `/api/internal/auto-approve-rules` without the header
- **AND** the server's `WEBHOOK_SECRET` env var is empty or unset
- **THEN** the server responds `200 OK` (same payload as authenticated mode)

### Requirement: First-boot seed of the rule table

On the first run of the Alembic migration that introduces `auto_approve_rules`, the system SHALL seed exactly 26 rows — one per `DocumentType` enum value — with `enabled=false` and a `min_confidence` derived from the legacy `AUTO_APPROVE_CONFIDENCE` env var if present, else `0.90`.

#### Scenario: Fresh install, no legacy env var

- **WHEN** the Alembic migration runs against an empty database AND `AUTO_APPROVE_CONFIDENCE` is unset
- **THEN** 26 rows are inserted in `auto_approve_rules`
- **AND** every row has `enabled=false`, `min_confidence=0.90`, `updated_by=null`

#### Scenario: Upgrade with legacy AUTO_APPROVE_CONFIDENCE=0.95

- **WHEN** the Alembic migration runs against an empty `auto_approve_rules` table AND `AUTO_APPROVE_CONFIDENCE=0.95` is set in the environment
- **THEN** 26 rows are inserted
- **AND** every row has `enabled=false`, `min_confidence=0.95`

#### Scenario: Upgrade with legacy AUTO_APPROVE_TYPES set

- **WHEN** the Alembic migration runs AND `AUTO_APPROVE_TYPES="Rechnung,Kontoauszug"` is set in the environment
- **THEN** an INFO log line `legacy_auto_approve_env_observed types=["Rechnung","Kontoauszug"]` is emitted
- **AND** the seeded rows for `Rechnung` and `Kontoauszug` STILL have `enabled=false` (the migration does NOT auto-enable based on the legacy allowlist; the maintainer re-enables via the UI)

#### Scenario: Re-running the migration after rows already exist

- **WHEN** the Alembic migration is re-run against a database that already has 26 rows
- **THEN** the migration is a no-op
- **AND** no rows are modified
- **AND** no `updated_at` values change
