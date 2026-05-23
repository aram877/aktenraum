## Why

Auto-approve today is controlled by two env vars in `docker/auto-tagger.env`: `AUTO_APPROVE_CONFIDENCE` (a single global threshold) and `AUTO_APPROVE_TYPES` (a comma-separated allowlist of document types). Both ship empty by default, which means auto-approve is effectively off — and turning it on requires the maintainer to SSH into the host, edit an env file, and `docker compose up -d --build auto-tagger` to recreate the container (`restart` alone doesn't re-read env files — a documented gotcha in CLAUDE.md).

That's wrong for three reasons. First, the single global threshold doesn't match reality: a `Rechnung` at confidence 0.85 is fine to auto-approve, but an `Ausweis` probably shouldn't auto-approve below 0.95 — risk is per-type, not global. Second, the maintainer is now using the product over Tailscale from mobile devices (per ADR-005); "go back to the host machine to edit an env file" was already friction for password change (fixed in `auth-password-change`) and is the same friction here. Third, the eval work in `scripts/eval-confidence-correlation.py` showed that picking a good threshold needs experimentation — the maintainer wants to tune per-type confidence floors iteratively from the same UI where they see the docs being classified, not by SSHing in.

This change moves auto-approve configuration to a per-document-type rule table in the `aktenraum` Postgres database, edited from a new section on `/settings`, and consumed by the auto-tagger over HTTP from `aktenraum-api`.

## What Changes

- **New table `auto_approve_rules`** in the `aktenraum` Postgres DB. One row per `DocumentType` enum value (26 rows). Columns: `document_type` (text PK, must match enum), `enabled` (bool), `min_confidence` (numeric(3,2), 0.00–1.00), `updated_by` (text, nullable), `updated_at` (timestamptz). Alembic migration creates the table and seeds all 26 rows with `enabled=false`, `min_confidence=0.90`. The seed is idempotent — a separate lifespan-startup reconciler inserts any missing `DocumentType` rows so adding a 27th enum value later is a one-liner.
- **New endpoints on `aktenraum-api`** (under `aktenraum_api.settings`, new module):
  - `GET /api/settings/auto-approve` — auth-gated; returns `{rules: [{document_type, enabled, min_confidence, updated_at, updated_by}]}` sorted by `document_type`. Used by the SPA.
  - `PUT /api/settings/auto-approve` — auth-gated; full-set replace payload `{rules: [{document_type, enabled, min_confidence}]}`. Validates each `document_type` is in the enum, each `min_confidence` is in `[0.00, 1.00]`, and the payload covers exactly the 26 enum values (no partial updates — this prevents the SPA from accidentally leaving rows untouched on a bug). Sets `updated_by` from the JWT subject.
  - `GET /api/internal/auto-approve-rules` — secret-header-gated (`X-Aktenraum-Secret`, reusing `WEBHOOK_SECRET`); same payload shape as the user-facing GET. Used by the auto-tagger. Returns 503 if the table is empty (shouldn't happen post-migration, but fail-closed if it does).
- **Auto-tagger consumes rules over HTTP** with an in-process TTL cache:
  - New module `services/auto-tagger/src/auto_tagger/auto_approve_config.py` exposing `async def get_rules() -> dict[DocumentType, Rule]`. 60-second TTL. On HTTP failure: log a warning, return the cached value if still in memory, else return a fail-closed default (`enabled=false` for every type — safer to under-approve than over-approve).
  - `tagger._route_lifecycle_tags` becomes `async` and consults the rules instead of `settings.auto_approve_types` / `settings.auto_approve_confidence`. The per-type `enabled` + `min_confidence` together replace both env vars.
  - **BREAKING (env vars)**: `AUTO_APPROVE_TYPES` is removed from `auto-tagger.env` (and `auto-tagger.env.example` + `Settings`). `AUTO_APPROVE_CONFIDENCE` is removed as a runtime input — kept as a one-shot **seed** read by the Alembic migration: if the env var is set when the migration runs and the table is empty, the migration uses it as the seed `min_confidence` value instead of `0.90`. After the first migration, the env var is ignored. This preserves the existing behaviour for an upgrading maintainer who already tuned the global value, without keeping a runtime fallback that would confuse "where is this number coming from."
- **New SPA section** on `/settings` titled "Auto-Genehmigung":
  - Table with 26 rows (one per `DocumentType`), columns: type name (German), `enabled` checkbox, `min_confidence` numeric input (step 0.05, range 0.00–1.00), last-updated timestamp + user.
  - Header actions: "Alle aktivieren" / "Alle deaktivieren" (bulk toggle), one Save button (full-set PUT). Reset button discards unsaved edits.
  - Read-only "Aktueller Wert" hint per row shows what the auto-tagger will actually use right now (re-fetched after Save so the user sees their change land).
  - German copy throughout, matching the existing Konto / Einstellungen section style.
- **`aktenraum-core` ProcessingBadge taxonomy unchanged.** This change only affects the routing decision pre-tag, not the lifecycle tags themselves.

### Out of scope (intentionally — defer to future changes)

- **Multi-tenant rules / per-user rules** — single-user product. The rules table has no `user_id` column; rules are global to the install. `updated_by` is informational only ("who last touched this") not authorisation.
- **Audit history table** — `updated_by` + `updated_at` capture the most recent change. A full change-log table (who flipped what to what, when) is the wrong abstraction to build for a feature that gets touched ~once per type ever. Revisit only if the maintainer asks for "show me how this rule evolved."
- **Per-correspondent rules** ("auto-approve Telekom invoices, never auto-approve Finanzamt") — out of scope for v1. The doc-type axis is the highest-leverage signal; correspondent-level overrides can layer on later without breaking the schema (add nullable `correspondent_id` column, treat NULL as the type-level default).
- **Confidence-vs-correctness eval rerun** — the existing `scripts/eval-confidence-correlation.py` continues to exist; this change just moves where the threshold lives, not how it's chosen. The eval re-runs against the new rule values once the corpus diversifies (per the existing N≥50 criterion in CLAUDE.md).
- **Migration of the existing `AUTO_APPROVE_TYPES` allowlist into per-type rules** — empty by default in the current deployment, so there's nothing to migrate. If a maintainer had it set, the migration logs the parsed list at INFO level for visibility, but does NOT auto-flip those types to `enabled=true` — the env var goes away and the maintainer re-enables in the UI. Documented in the changelog.

## Capabilities

### New Capabilities
None. This extends existing capabilities; no new capability domain.

### Modified Capabilities
- `aktenraum-api`: gains a `settings.auto_approve` sub-module with two user-facing endpoints (`GET` + `PUT /api/settings/auto-approve`) and one internal endpoint (`GET /api/internal/auto-approve-rules`), plus a new SQLAlchemy model + Alembic migration for the `auto_approve_rules` table.
- `auto-tagger`: routing decision becomes async and is sourced from `aktenraum-api` (with 60s TTL + fail-closed fallback) instead of static env vars. `AUTO_APPROVE_TYPES` + `AUTO_APPROVE_CONFIDENCE` are removed from the `Settings` Pydantic class.
- `aktenraum-web`: gains an "Auto-Genehmigung" section on `/settings` with a 26-row editable table backed by the new endpoints.

## Impact

- **Code (backend — `aktenraum-api`)**:
  - `services/aktenraum-api/src/aktenraum_api/settings/` — new module: `__init__.py`, `router.py`, `service.py`, `schemas.py`, `models.py`.
  - `services/aktenraum-api/src/aktenraum_api/main.py` — register the new router; add lifespan reconciler that ensures every `DocumentType` enum value has a row (insert missing only, never delete).
  - `services/aktenraum-api/alembic/versions/<new>_auto_approve_rules.py` — create table + seed 26 rows (reading the legacy `AUTO_APPROVE_CONFIDENCE` env var as the seed `min_confidence` if present, else `0.90`).
  - `services/aktenraum-api/tests/test_settings_auto_approve.py` — new test file: GET (auth required), PUT (validation, full-set, audit fields), `/internal` endpoint (secret required, payload shape).
- **Code (backend — `auto-tagger`)**:
  - `services/auto-tagger/src/auto_tagger/auto_approve_config.py` — new module (TTL cache + HTTP client + fail-closed default).
  - `services/auto-tagger/src/auto_tagger/tagger.py` — `_route_lifecycle_tags` becomes `async`; consults the rule store instead of `Settings`.
  - `services/auto-tagger/src/auto_tagger/config.py` — remove `auto_approve_confidence` + `auto_approve_types` fields; add `aktenraum_api_url` + `webhook_secret` (the latter already exists). The `NoDecode` workaround for comma-separated lists can also go.
  - `services/auto-tagger/tests/test_tagger.py` — replace the env-var-based routing matrix tests with rule-store-injection tests (the routing matrix coverage stays — only the source of the inputs changes).
  - `docker/auto-tagger.env.example` — remove the two retired vars; add `AKTENRAUM_API_URL=http://aktenraum-api:8002` (the only new var; `WEBHOOK_SECRET` already exists).
- **Code (SPA)**:
  - `apps/web/src/lib/api.ts` — `getAutoApproveRules()`, `updateAutoApproveRules(rules)` helpers.
  - `apps/web/src/lib/settings.ts` — new file: `useAutoApproveRules()`, `useUpdateAutoApproveRules()` (TanStack Query hooks; invalidation key shared with the Settings page).
  - `apps/web/src/routes/Settings.tsx` — new "Auto-Genehmigung" section below the existing Konto section.
  - German doc-type display names: reuse the existing mapping from `apps/web/src/lib/doc-types.ts` (already used by Inbox / Library); no new translation file needed.
- **DB**: new table `auto_approve_rules` with 26 seeded rows. No changes to existing tables.
- **Env / config**:
  - `docker/auto-tagger.env.example` — remove `AUTO_APPROVE_TYPES`, remove `AUTO_APPROVE_CONFIDENCE` (one-time seed only), add `AKTENRAUM_API_URL`.
  - `docker/docker-compose.yml` — add `aktenraum-api` to `auto-tagger`'s `depends_on` (the auto-tagger now needs aktenraum-api to be reachable on startup; without it the fail-closed default fires and nothing auto-approves until the cache fills).
  - **Backwards compatibility**: an upgrading maintainer with `AUTO_APPROVE_CONFIDENCE` and/or `AUTO_APPROVE_TYPES` set sees these values logged at INFO during the migration ("legacy_auto_approve_env_observed: confidence=0.95 types=Rechnung,Kontoauszug — seeded min_confidence into table; enabled flags must be re-set via the UI") but the runtime no longer reads them after first boot.
- **Docs**:
  - `CLAUDE.md` — update the "Auto-tagger behaviour → Confidence-based routing" section to describe the rule table instead of env vars; add a new gotcha row about the 60s TTL cache (rule changes take up to 60s to take effect in the auto-tagger).
  - Session note when shipped.
- **Security**:
  - The user-facing endpoints are auth-gated (existing cookie auth pattern).
  - The `/internal` endpoint reuses `WEBHOOK_SECRET` — the same shared secret that already gates `/trigger/extract`. No new secret to manage.
  - The auto-tagger fails CLOSED when it can't reach `aktenraum-api`: it returns "no rule, do not auto-approve" rather than a permissive default. A network partition between the two services cannot accidentally enable auto-approve on types the user has disabled.
