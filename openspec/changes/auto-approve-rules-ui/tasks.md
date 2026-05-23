## 1. Shared model (aktenraum-core)

- [x] 1.1 Add `AutoApproveRule` Pydantic model in `packages/aktenraum-core/src/aktenraum_core/models/auto_approve.py` with fields `document_type: DocumentType`, `enabled: bool`, `min_confidence: float` (constrained `ge=0.0, le=1.0` with 2-decimal serialisation), `updated_at: datetime | None`, `updated_by: str | None`. Re-export from `aktenraum_core.models.__init__`.
- [x] 1.2 Add a unit test in `services/auto-tagger/tests/test_models.py` confirming `min_confidence` rejects values <0 or >1 and accepts the boundary values 0.0 and 1.0.
- [x] 1.3 Run `uv run pytest packages/aktenraum-core` (or the whole workspace) to confirm the model imports cleanly from both members.

## 2. aktenraum-api — schema + storage

- [x] 2.1 Create `services/aktenraum-api/src/aktenraum_api/settings/__init__.py`, `models.py`, `schemas.py`, `service.py`, `router.py` (module skeleton mirroring the existing `auth/` and `inbox/` modules). _Existing `settings/` module re-used; added `auto_approve_schemas.py` + `auto_approve_service.py` alongside the existing LLM-quality files._
- [x] 2.2 Define the SQLAlchemy model `AutoApproveRuleRow` in `settings/models.py` with columns `document_type: str` (PK, length matches longest enum value), `enabled: bool` (default `False`), `min_confidence: Numeric(3, 2)` (default `0.90`), `updated_at: TIMESTAMP WITH TIME ZONE` (nullable), `updated_by: String(255)` (nullable). Table name `auto_approve_rules`. _Added to `db/models.py` next to the other Base subclasses._
- [x] 2.3 Define Pydantic request/response schemas in `settings/schemas.py`: `AutoApproveRuleEntry` (single row, matches `AutoApproveRule` from core), `AutoApproveRulesResponse` (`rules: list[AutoApproveRuleEntry]`), `AutoApproveRulesUpdateRequest` (full-set; field validator enforces exactly 26 entries with no duplicates and every `DocumentType` represented).
- [x] 2.4 Create the Alembic migration `services/aktenraum-api/alembic/versions/<timestamp>_auto_approve_rules.py`. `upgrade()` creates the table, reads `os.environ.get("AUTO_APPROVE_CONFIDENCE")` (default `0.90`), reads `os.environ.get("AUTO_APPROVE_TYPES")` and logs the parsed value at INFO if non-empty, inserts 26 rows (one per `DocumentType` enum value) with `enabled=False` and the resolved `min_confidence`. `downgrade()` drops the table.
- [x] 2.5 Write `settings/service.py` with `async def list_rules(session) -> list[AutoApproveRuleEntry]` (single SELECT, sorted by `document_type`) and `async def replace_rules(session, payload, updated_by) -> list[AutoApproveRuleEntry]` (single transaction: UPSERT 26 rows by PK, set `updated_at=now()`, `updated_by=updated_by`).
- [x] 2.6 Add a lifespan reconciler in `aktenraum_api.main` that runs on startup AFTER `alembic upgrade head`: SELECT all rows, compute the set difference against `DocumentType` enum values, INSERT missing rows with the same defaults as the migration. Idempotent — no UPDATE/DELETE. Log `auto_approve_rules_reconciled` with the count of inserted rows (0 in the steady state).

## 3. aktenraum-api — endpoints

- [x] 3.1 Implement `GET /api/settings/auto-approve` in `settings/router.py`. Auth-gated (reuse `Depends(get_current_user)` from auth). Returns `AutoApproveRulesResponse`.
- [x] 3.2 Implement `PUT /api/settings/auto-approve` in `settings/router.py`. Auth-gated. Body: `AutoApproveRulesUpdateRequest`. Validates duplicates / missing / unknown `document_type` via the Pydantic model_validator (422 on any violation). On success: returns the new state via the same shape as GET, sets `updated_by` from the JWT subject.
- [x] 3.3 Internal endpoint: `GET /api/settings/active-auto-approve-rules` in the SAME router (mirrors the existing `active-llm-model` pattern instead of introducing a new `/api/internal/` prefix). Validates `X-Aktenraum-Secret` against `settings.webhook_secret` (401 on mismatch when set; skip the check when empty). NO `Depends(get_current_user)`.
- [x] 3.4 Already registered — `settings_router` is included in `create_app()`. No new router prefix needed thanks to the same-module choice in 3.3.

## 4. aktenraum-api — tests

- [x] 4.1 Create `services/aktenraum-api/tests/test_settings_auto_approve.py`. Use the existing httpx + AsyncSession test fixtures (mirror `test_auth_flow.py`).
- [x] 4.2 Test `GET /api/settings/auto-approve` returns 26 rows in the seeded state (all `enabled=false`, `min_confidence=0.90`, `updated_by=null`); 401 when unauthenticated.
- [x] 4.3 Test `PUT /api/settings/auto-approve` happy path: valid 26-entry payload returns 200 with `updated_at`/`updated_by` populated; subsequent GET reflects the change.
- [x] 4.4 Test PUT validation failures: missing `Rechnung` entry → 422 (Pydantic model_validator); duplicate `Vertrag` entries → 422; unknown `document_type` → 422; `min_confidence=1.5` → 422; unauthenticated → 401.
- [x] 4.5 Test `GET /api/settings/active-auto-approve-rules` (the chosen internal-endpoint path): 200 with correct `X-Aktenraum-Secret`, 401 with wrong/missing header when secret is set, 200 without header when secret is empty.
- [x] 4.6 Test the lifespan reconciler: if a row is missing (manually `DELETE FROM auto_approve_rules WHERE document_type = 'Rechnung'`), restarting the app re-inserts it with `enabled=false`, `min_confidence=0.90`; rows that already exist are untouched (`updated_at` remains as before).

## 5. auto-tagger — rule client + cache

- [x] 5.1 Created `services/auto-tagger/src/auto_tagger/auto_approve_config.py`. Module-level state + `asyncio.Lock` + `CACHE_TTL_SECONDS = 60`. Return type is a `RuleSet` dataclass instead of a bare dict so the routing function can distinguish operator-disabled from fail-closed (cleaner than a sentinel key).
- [x] 5.2 `async def get_rules(settings) -> RuleSet`: cache-hit fast path; on miss, GET `/api/settings/active-auto-approve-rules` (the existing internal-endpoint convention, not `/api/internal/`); `X-Aktenraum-Secret` header set when `webhook_secret` is non-empty.
- [x] 5.3 On HTTP failure with populated cache: reuse cache, log WARN. On cold-start failure: return `RuleSet(fail_closed=True)` with every type disabled at `min_confidence=1.0`; do NOT mark cache loaded so the next call retries immediately.
- [x] 5.4 `aktenraum_api_url` already existed on `Settings` (used by the type-specific-fields PATCH). Removed `auto_approve_confidence` + `auto_approve_types` fields, the `_split_csv` field validator, the `NoDecode` annotation, and the `typing.Annotated` import. Conftest fixture cleaned up too.
- [x] 5.5 `httpx` already in deps (used by `backend_provider.py` for the LLM-model fetch). No new dependency.

## 6. auto-tagger — routing decision rewire

- [x] 6.1 `_route_lifecycle_tags` signature changed to accept the `RuleSet`. Kept SYNCHRONOUS (the RuleSet is fetched once in `process_document` then passed in) — pure routing logic is easier to test sync, and the caller is the only entry point.
- [x] 6.2 New routing logic via `RuleSet`: missing-rule or disabled → `type_disabled`; below `min_confidence` → `confidence_below_min`; both gates pass → auto-approve. `ai-low-confidence` aux tag appends in the pending branches via the existing `_pending()` helper.
- [x] 6.3 `process_document` fetches `rules = await get_rules(settings)` between the AI-fields PATCH and the routing decision; passes into `_route_lifecycle_tags`. `routing_decision` log line unchanged in shape.
- [x] 6.4 `RuleSet.fail_closed=True` triggers the `rules_unreachable_fail_closed` reason (checked first, before per-type lookup). Low-confidence aux tag still appends.

## 7. auto-tagger — tests

- [x] 7.1 Replaced env-var-based routing matrix in `test_tagger.py` with rule-store-injection tests via a `_build_rules()` helper.
- [x] 7.2 Cover the 4 reason enum values: `auto_approved`, `type_disabled`, `confidence_below_min`, `rules_unreachable_fail_closed`. Low-confidence aux tag covered in all three pending branches.
- [x] 7.3 New `test_auto_approve_config.py`: cache-hit dedup, TTL expiry refetch (monkeypatched clock), HTTP failure with cache → reuse + WARN, cold-start HTTP failure → fail-closed + WARN + no cache mark, secret header sent when configured, omitted otherwise. Uses `respx` (already in dev deps).
- [x] 7.4 `uv run pytest` — 624 passed, 7 warnings, no failures.
- [x] 7.5 `uv run ruff check` — All checks passed.

## 8. Compose + env wiring

- [x] 8.1 `auto-tagger.env.example`: removed `AUTO_APPROVE_CONFIDENCE` + `AUTO_APPROVE_TYPES`, replaced the section with a comment pointing at the new rule store. `AKTENRAUM_API_URL` already at the bottom of the file. `WEBHOOK_SECRET` line remains.
- [x] 8.2 `docker-compose.yml`: added `aktenraum-api: condition: service_started` to `auto-tagger`'s `depends_on`.
- [x] 8.3 `aktenraum-api.env.example` already exposes `WEBHOOK_SECRET` (line 55) — no change needed.
- [x] 8.4 `bootstrap-secrets.sh` already reconciles `WEBHOOK_SECRET` across `.env`, `aktenraum-api.env`, and `auto-tagger.env` (line 232–233 of the script). No changes needed.

## 9. SPA — API client + hooks

- [x] 9.1 Added `fetchAutoApproveRules` + `putAutoApproveRules` directly inside `apps/web/src/lib/settings.ts` (kept consistent with the existing `useLLMSettings` pattern; no need to dance them through `api.ts`).
- [x] 9.2 Extended `apps/web/src/lib/settings.ts` (file already existed for LLM settings). Exported `AUTO_APPROVE_KEY`, `useAutoApproveRules` (`staleTime: 30s`), `useUpdateAutoApproveRules` (writes back to the cache on success via `qc.setQueryData`).
- [x] 9.3 Skipped — `web:types` requires the API running and the existing `settings.ts` uses hand-written types for `LLMSettings` for the same reason. The hand-written types match the server schemas (`AutoApproveRulesResponse`, `AutoApproveRule`, `AutoApproveRuleUpdate`).

## 10. SPA — Settings page section

- [x] 10.1 New `AutoApproveSection` component above the Klassifikations-Modell section in `Settings.tsx`. German title + 2-line explainer about the 60s cache lag.
- [x] 10.2 Table renders 26 rows via `useAutoApproveRules()`, sorted alphabetically by enum value (the values ARE the German display names — no separate mapping needed). Columns: Typ, Aktiviert, Min. Konfidenz, Zuletzt geändert.
- [x] 10.3 Local state is a `Map<DocumentType, {enabled, min_confidence}>` rebuilt via `useEffect` whenever the fetched data changes. `_isDirty()` walks the server rules to detect drift.
- [x] 10.4 Bulk "Alle aktivieren" / "Alle deaktivieren" buttons mutate the whole map; Save + Zurücksetzen buttons gated on `dirty && !isPending`.
- [x] 10.5 Save handler builds the full 26-entry payload (rounded to 2-decimal precision matching `Numeric(3,2)`), invokes `useUpdateAutoApproveRules().mutateAsync`, shows a green toast for ~2.5s on success.
- [x] 10.6 Reset rebuilds the draft from `data.rules` — instant cancel without HTTP.
- [x] 10.7 Yellow "Achtung: niedriger Schwellwert" pill driven off `serverRule.min_confidence < 0.7` (server state, not draft) so editing before save doesn't flash the warning.
- [x] 10.8 Followed the existing Settings-page style: rounded-md borders, h-* inputs in line with the Konto section, table wrapped in `overflow-x-auto` so it scrolls horizontally on narrow screens. The 4-column table stays compact enough on phones (Typ name + checkbox + small number input + dimmed timestamp).

## 11. Documentation + cleanup

- [x] 11.1 Replaced the routing-rules table in CLAUDE.md "Confidence-based routing" with the per-type rule-store explanation; added the 4-line decision matrix, the fail-closed semantics, and the 60s TTL cache pointer. Removed the legacy env-var paragraph.
- [x] 11.2 Removed the obsolete "Auto-approve requires BOTH `AUTO_APPROVE_CONFIDENCE` AND non-empty `AUTO_APPROVE_TYPES`" gotcha row. Added a new row "Auto-approve rule changes take up to 60s to take effect in the auto-tagger" with full cache + failure-mode explanation. Updated the "Auto-approve doesn't fire" debugging row's reason-enum values. Removed the `pydantic-settings NoDecode` gotcha row (was a workaround for the deleted `auto_approve_types` field).
- [x] 11.3 Updated the Credentials table. Webhook secret row now lists all three env files + names the secret-gated internal endpoints. Added a new `auto-tagger → api` row documenting `AKTENRAUM_API_URL`.
- [x] 11.4 Added "Auto-Genehmigung settings (per-type, edited in SPA)" row to "What's implemented vs planned", marked ✅.
- [x] 11.5 Wrote `docs/sessions/2026-05-23-auto-approve-rules-ui.md` covering: what shipped (by feature), rollback procedure, things-to-pick-up-next-session, active roadmap progress. Commit hash slot left as TBD.

## 12. Verification

- [ ] 12.1 Local end-to-end: `task tagger:rebuild api:rebuild`, log into SPA, navigate to `/settings`, confirm the Auto-Genehmigung section renders with 26 rows all disabled at 0.90 (or the legacy env-var value if it was set pre-upgrade). _Pending user E2E._
- [ ] 12.2 Edit a rule (enable `Rechnung`, set `min_confidence=0.85`), Save, confirm the row updates with the timestamp + username. _Pending user E2E._
- [ ] 12.3 Upload a test Rechnung where `ai_confidence >= 0.85`. Within 60s confirm the auto-tagger logs `routing_decision reason=auto_approved` and the document goes straight to `ai-approved` → `ai-propagated` (skipping the inbox). _Pending user E2E._
- [ ] 12.4 Disable `Rechnung` in the UI; re-upload another Rechnung. Confirm it lands in the inbox with `routing_decision reason=type_disabled`. _Pending user E2E._
- [ ] 12.5 Stop `aktenraum-api`, restart `auto-tagger` (force a cold start), upload a Rechnung. Confirm the worker logs `auto_approve_rules_unreachable_fail_closed` and tags `ai-pending` regardless of the rule state. _Pending user E2E._
- [x] 12.6 `uv run pytest` from the repo root — 624 passed, 7 warnings (all pre-existing), no failures.
- [x] 12.7 `uv run ruff check` — All checks passed. `pnpm --filter @aktenraum/web lint` — 0 errors, 2 warnings (both pre-existing on `main`, not from this change).
