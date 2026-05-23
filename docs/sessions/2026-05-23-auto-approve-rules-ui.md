# 2026-05-23 — Auto-Genehmigung settings UI

## What shipped

OpenSpec change `auto-approve-rules-ui` — moved the auto-approve gate from
two env vars (`AUTO_APPROVE_TYPES`, `AUTO_APPROVE_CONFIDENCE`) to a per-
`DocumentType` rule table in Postgres, edited from `/settings →
Auto-Genehmigung` and consumed by the auto-tagger over HTTP with a 60-
second TTL cache.

By feature:

- **aktenraum-core**: new `AutoApproveRule` Pydantic model
  (`packages/aktenraum-core/src/aktenraum_core/models/auto_approve.py`)
  shared between the two Python services. `min_confidence` constrained to
  `[0.00, 1.00]`.
- **aktenraum-api**:
  - New `auto_approve_rules` Postgres table (Alembic migration 0005), one
    row per `DocumentType` enum value (26 in total).
  - The migration reads the legacy `AUTO_APPROVE_CONFIDENCE` env var ONCE
    as the seed `min_confidence` for all 26 rows, logs the legacy
    `AUTO_APPROVE_TYPES` value at INFO for visibility, and does NOT
    auto-enable any types.
  - Three endpoints in `settings/router.py`:
    - `GET /api/settings/auto-approve` (auth)
    - `PUT /api/settings/auto-approve` (auth, full-set replace, 26 entries
      required)
    - `GET /api/settings/active-auto-approve-rules` (secret-gated,
      consumed by the auto-tagger).
  - Lifespan reconciler in `main.py` inserts a row for any new
    `DocumentType` enum value on next boot (no migrations needed for
    enum extensions).
- **auto-tagger**:
  - New `auto_approve_config.py` with an in-process 60s TTL cache. Returns
    a `RuleSet` dataclass exposing `by_type` + `fail_closed`. HTTP error
    with populated cache → reuse cache + WARN; cold-start error → return
    fail-closed default + WARN, do NOT mark cache loaded (next call
    retries instead of waiting out the TTL).
  - `_route_lifecycle_tags` rewired to consume the `RuleSet`. The
    `routing_decision` log line carries the new closed-enum `reason`
    values: `auto_approved`, `type_disabled`, `confidence_below_min`,
    `rules_unreachable_fail_closed`.
  - `Settings` cleaned up: removed `auto_approve_confidence`,
    `auto_approve_types`, the `_split_csv` field validator, and the
    `Annotated[list[str], NoDecode]` + `typing.Annotated` import.
  - `docker/auto-tagger.env.example` removes both legacy env vars.
- **aktenraum-web**:
  - New `Auto-Genehmigung` section on `/settings`. 26-row table
    (alphabetical), `enabled` checkbox + `min_confidence` numeric input
    per row, last-changed timestamp + username, bulk
    "Alle aktivieren/deaktivieren" buttons, Save + Reset.
  - Yellow "Achtung: niedriger Schwellwert" pill rendered when the
    SERVER's `min_confidence < 0.7` for that row (driven off server state,
    not draft, so editing without saving doesn't flicker the warning).
- **docker-compose.yml**: `auto-tagger` now lists `aktenraum-api:
  condition: service_started` in `depends_on` so the rule fetch has a
  reasonable startup ordering. Fail-closed handles slow starts where the
  api isn't ready yet.
- **Tests**:
  - aktenraum-core: 6 new test cases for the `AutoApproveRule` model.
  - aktenraum-api: 13 new tests in `test_settings_auto_approve.py`
    (CRUD happy path + validation failures + internal endpoint + the
    lifespan reconciler).
  - auto-tagger: routing matrix in `test_tagger.py` rewritten to inject
    `RuleSet` directly; 8 new tests in `test_auto_approve_config.py` for
    the TTL cache, HTTP failure modes, and secret-header behaviour.
  - Total: 624 tests pass (up from ~600); `ruff check` clean.

## Commit hashes

TBD — to be filled when shipped.

## Rollback

The migration's `downgrade()` is `DROP TABLE auto_approve_rules`. If the
deploy needs rollback, pin both `aktenraum-api` and `auto-tagger` images
to the previous tag. The pre-change env vars
(`AUTO_APPROVE_CONFIDENCE`, `AUTO_APPROVE_TYPES`) need to be re-added to
`docker/auto-tagger.env` from the old example if they were removed. Note
that there is no automatic "re-enable previously enabled types" path —
the legacy env vars were only logged at migration time, not used to seed
`enabled=true` for any rows.

## Things to pick up next session

- **Local end-to-end verification** (task 12.1–12.5 of the change). The
  unit + integration tests are green and the SPA + API + auto-tagger all
  type-check / lint clean, but the change has NOT been exercised against
  a running stack yet. Next session: `task tagger:rebuild api:rebuild`,
  log into SPA, walk through the 4 scenarios in tasks.md §12.
- **`task test` + `task lint` (12.6, 12.7)**: ran the python halves via
  `uv run pytest` and `uv run ruff check`. SPA lint is clean. SPA build
  fails on `Scan.tsx` due to a pre-existing missing `react-image-crop`
  dep on `main` (unrelated to this change — the upstream
  `revert(spa): remove auto edge detection + perspective warp` left
  stale imports).
- **CLAUDE.md `Webhook secret` row** — updated to mention the new
  internal endpoint, but a future change might warrant a dedicated
  section listing all secret-gated internal endpoints in one place
  (today there are two: `active-llm-model` and
  `active-auto-approve-rules`).

## Active roadmap progress

OpenSpec change `auto-approve-rules-ui` is 53/60 tasks done — only the
end-to-end verification + the `task test` / `task lint` invocations
remain.
