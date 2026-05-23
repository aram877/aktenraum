## ADDED Requirements

### Requirement: Auto-tagger sources routing rules from the aktenraum-api rule store

The auto-tagger SHALL fetch per-`DocumentType` auto-approve rules over HTTP from `aktenraum-api` (`GET /api/internal/auto-approve-rules`) and cache them in-process with a 60-second TTL. The fetched rule set SHALL drive the routing decision in `tagger._route_lifecycle_tags` in place of the static `AUTO_APPROVE_TYPES` allowlist and `AUTO_APPROVE_CONFIDENCE` threshold env vars.

When the rule store is unreachable AND no cached rule set exists, the auto-tagger MUST fail closed — synthesise a rule set with `enabled=false` for every `DocumentType` so no document is auto-approved during the outage.

#### Scenario: Type enabled and confidence at or above the per-type threshold

- **WHEN** the LLM extracts a document with `document_type=Rechnung` and `confidence=0.92`
- **AND** the rule store contains `{document_type: "Rechnung", enabled: true, min_confidence: 0.90}`
- **THEN** `_route_lifecycle_tags` returns the tag list `["ai-approved", "ai-auto-approved"]`
- **AND** the propagation watcher picks the document up within ~30 seconds

#### Scenario: Type enabled but confidence below per-type threshold

- **WHEN** the LLM extracts a document with `document_type=Rechnung` and `confidence=0.80`
- **AND** the rule store contains `{document_type: "Rechnung", enabled: true, min_confidence: 0.90}`
- **THEN** `_route_lifecycle_tags` returns `["ai-pending"]` (NOT `ai-approved`)
- **AND** if `confidence < LOW_CONFIDENCE_THRESHOLD` the auxiliary tag `ai-low-confidence` is included

#### Scenario: Type disabled regardless of confidence

- **WHEN** the LLM extracts a document with `document_type=Ausweis` and `confidence=0.99`
- **AND** the rule store contains `{document_type: "Ausweis", enabled: false, min_confidence: 0.90}`
- **THEN** `_route_lifecycle_tags` returns `["ai-pending"]` (NOT `ai-approved`), even with confidence above the threshold

#### Scenario: Cache hit — multiple routings within TTL share one fetch

- **WHEN** the auto-tagger routes 5 documents within a 60-second window
- **AND** the first routing call populated the cache from `aktenraum-api`
- **THEN** the subsequent 4 routing calls reuse the cached rule set and make NO additional HTTP calls

#### Scenario: Cache expired — re-fetch on next routing call

- **WHEN** the auto-tagger routes a document more than 60 seconds after the last successful rule fetch
- **THEN** the auto-tagger re-fetches the rule set from `aktenraum-api` before deciding
- **AND** any rule changes saved in the SPA within that window are reflected in the new decision

#### Scenario: Rule store unreachable with populated cache — degrade gracefully

- **WHEN** the cache TTL expires AND the HTTP refresh call to `aktenraum-api` fails (timeout, 5xx, network error)
- **AND** a previously-cached rule set is still in memory
- **THEN** the auto-tagger reuses the cached rule set for the current decision
- **AND** logs `auto_approve_rules_fetch_failed_using_cache` at WARN level
- **AND** retries the fetch on the next routing call (does NOT wait the full TTL)

#### Scenario: Cold-start fail-closed when rule store is unreachable

- **WHEN** the auto-tagger attempts its FIRST rule fetch AND `aktenraum-api` is unreachable
- **THEN** the auto-tagger synthesises a fail-closed rule set (`enabled=false` for every `DocumentType`)
- **AND** every routing decision during the outage tags `ai-pending`
- **AND** logs `auto_approve_rules_unreachable_fail_closed` at WARN level
- **AND** retries on the next routing call (does NOT cache the synthetic fail-closed value as if it were a successful fetch)

#### Scenario: Internal endpoint is secret-gated

- **WHEN** the auto-tagger calls `GET /api/internal/auto-approve-rules`
- **AND** `WEBHOOK_SECRET` is set in `docker/auto-tagger.env`
- **THEN** the request includes header `X-Aktenraum-Secret: <secret>`
- **AND** the same secret is set in `docker/aktenraum-api.env` (reconciled by `bootstrap-secrets.sh`)

#### Scenario: AKTENRAUM_API_URL is configurable

- **WHEN** `AKTENRAUM_API_URL` is set in `docker/auto-tagger.env`
- **THEN** the auto-tagger uses that base URL for the rule-fetch call
- **AND** when unset, defaults to `http://aktenraum-api:8002`

## MODIFIED Requirements

### Requirement: Auto-tagger logs the routing-decision reason

`tagger._route_lifecycle_tags` SHALL return both the tag list AND a structured `reason` string explaining the auto-approve gate's decision. The caller (`process_document`) SHALL include this `reason` in the `routing_decision` log event alongside the existing `tags`, `confidence`, and `document_type` fields. Reasons SHALL be one of an enumerated set: `"auto_approved"`, `"type_disabled"`, `"confidence_below_min"`, `"rules_unreachable_fail_closed"`.

The reason MUST NOT affect routing behaviour — this requirement is purely about observability. The gate's logic is `rule[document_type].enabled AND confidence ≥ rule[document_type].min_confidence`, with the rule set sourced from the aktenraum-api rule store (see "Auto-tagger sources routing rules from the aktenraum-api rule store").

#### Scenario: Auto-approve fires and logs `auto_approved`

- **WHEN** an extraction returns `document_type=Rechnung`, `confidence=0.98`
- **AND** the rule store contains `{document_type: "Rechnung", enabled: true, min_confidence: 0.95}`
- **THEN** `_route_lifecycle_tags` returns `(["ai-approved", "ai-auto-approved"], "auto_approved")` and the `routing_decision` log line carries `reason="auto_approved"`

#### Scenario: Type disabled logs `type_disabled`

- **WHEN** an extraction returns `document_type=Vertrag`, `confidence=0.99`
- **AND** the rule store contains `{document_type: "Vertrag", enabled: false, min_confidence: 0.90}`
- **THEN** `_route_lifecycle_tags` returns `(["ai-pending"], "type_disabled")` and the log line carries `reason="type_disabled"`

#### Scenario: Confidence below per-type minimum logs `confidence_below_min`

- **WHEN** an extraction returns `document_type=Rechnung`, `confidence=0.80`
- **AND** the rule store contains `{document_type: "Rechnung", enabled: true, min_confidence: 0.95}`
- **THEN** `_route_lifecycle_tags` returns `(["ai-pending"], "confidence_below_min")` (potentially with `ai-low-confidence` if also below `LOW_CONFIDENCE_THRESHOLD`) and the log line carries `reason="confidence_below_min"`

#### Scenario: Rules unreachable at cold start logs `rules_unreachable_fail_closed`

- **WHEN** an extraction routing call fires AND the auto-tagger has never successfully fetched the rule store (cold start) AND the HTTP call fails
- **THEN** `_route_lifecycle_tags` returns `(["ai-pending"], "rules_unreachable_fail_closed")` and the log line carries `reason="rules_unreachable_fail_closed"`
- **AND** if `confidence < LOW_CONFIDENCE_THRESHOLD`, the auxiliary `ai-low-confidence` tag is included alongside

## REMOVED Requirements

### Requirement: Auto-approve allowlist and global threshold are configured via env vars

**Reason**: Replaced by the per-`DocumentType` rule store in `aktenraum-api` (see ADDED "Auto-tagger sources routing rules from the aktenraum-api rule store"). The env-var model couldn't support per-type confidence thresholds, required a container rebuild to change, and made the operator SSH to the host for tuning.

**Migration**:
- `AUTO_APPROVE_TYPES` is removed from `docker/auto-tagger.env.example` and from the `Settings` Pydantic class (`auto_approve_types` field deleted along with its `NoDecode` annotation and the `_split_csv` field validator). An upgrading maintainer with a non-empty value sees it logged at INFO during the first aktenraum-api boot (`legacy_auto_approve_env_observed`) but the value has no runtime effect; the maintainer re-enables the desired types from `/settings → Auto-Genehmigung`.
- `AUTO_APPROVE_CONFIDENCE` is removed from `docker/auto-tagger.env.example` and from the `Settings` Pydantic class. The Alembic migration that creates `auto_approve_rules` reads the env var ONCE (if present at migration time) and uses its value as the seed `min_confidence` for all 26 seeded rows; otherwise seeds with `0.90`. After first boot, the env var is ignored.
- The auto-tagger gains a new env var `AKTENRAUM_API_URL` (default `http://aktenraum-api:8002`) for the rule-fetch endpoint. `WEBHOOK_SECRET` (already shared between auto-tagger and aktenraum-api via `bootstrap-secrets.sh`) gates the new internal endpoint — no new secret to manage.
