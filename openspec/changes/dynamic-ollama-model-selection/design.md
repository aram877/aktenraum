## Context

`AppSettings.llm_quality` / `AppSettings.answer_llm_quality` (Postgres, singleton row id=1) currently store a symbolic tier (`"high"` / `"medium"`) resolved to a literal Ollama model tag through the hardcoded `QUALITY_TO_MODEL` dict in `aktenraum_api/settings/quality.py`. Three call paths depend on this today:

1. **aktenraum-api's own LLM calls** (`ai/deps.py::_build_backend`) — reads `settings_service.get_active_model(session)` / `get_active_answer_model(session)` per request, which resolve tier → model via `QUALITY_TO_MODEL`.
2. **auto-tagger's extraction backend** (`backend_provider.py::_resolve_ollama_model`) — HTTP GETs `${AKTENRAUM_API_URL}/api/settings/active-llm-model`, parses the JSON body's `ollama_model` key, falls back to its own `OLLAMA_MODEL` env var if the api is unreachable or the field is missing/empty. **This field name (`ollama_model`) is a wire contract auto-tagger already parses — it must not change name or type**, even though the meaning of the *other* field on that response (`quality`) is going away.
3. **SPA Settings page** — renders a 2-radio picker from a hardcoded `OPTIONS` TS array mirroring the same tiers, calls `PATCH /settings/llm` / `/settings/answer-llm` with `{quality: "high"|"medium"}`.

`aktenraum-api` already has an `ollama_base_url` (`config.py`) and the `ollama` Python client is already a dependency (via `aktenraum_core.llm.ollama_backend`), so listing pulled models is a matter of calling `AsyncClient(host=...).list()` — no new dependency.

## Goals / Non-Goals

**Goals:**
- Store and use a literal Ollama model tag end-to-end instead of a symbolic tier, so any locally-pulled model (`gemma4:e4b`, etc.) is selectable without a code change.
- Let the SPA discover what's actually pulled via a live Ollama query, so the operator doesn't have to know exact tag spelling.
- Preserve the auto-tagger's existing internal-endpoint contract (`GET /api/settings/active-llm-model` response shape `{..., ollama_model: str}`) so the auto-tagger side needs zero changes.
- Migrate existing installs' stored tier values to concrete model tags without operator intervention (Alembic `upgrade head` already runs on every container start).

**Non-Goals:**
- Anthropic model selection (`ANTHROPIC_MODEL` / `ANTHROPIC_ANSWER_MODEL` stay env-only, unchanged).
- Live validation of a saved model tag against Ollama's pulled list — over-validating would block a save whenever Ollama is briefly unreachable, and a bad tag already surfaces clearly at extraction time (`model '<name>' not found (404)`, an existing documented gotcha).
- Changing `OLLAMA_MODEL` / `OLLAMA_ANSWER_MODEL` env-var fallback semantics in the auto-tagger or in `ai/deps.py`'s answer-role env-precedence — both are out of scope and continue to work exactly as today.
- Any change to auto-approve rules or confidence routing.

## Decisions

**1. Rename DB columns `llm_quality`/`answer_llm_quality` → `llm_model`/`answer_llm_model`, widen to `String(128)`.**
Alternative considered: keep the column names and just change what's stored in them (still a tier-shaped string, now holding a model tag). Rejected — a column named `*_quality` holding `"gemma4:e4b"` is actively misleading to the next reader; the rename cost is one migration and it's paid once. `String(128)` comfortably covers Ollama's longest realistic tags (existing tier strings were capped at 16, which is already too narrow for `qwen2.5:14b-instruct-q8_0`... wait, that's 25 chars — the *current* schema already tightly fits only short symbolic names, confirming the column was never meant to hold a real tag).

**2. Migration backfills via a literal one-time copy of today's `QUALITY_TO_MODEL`, then the tier module is deleted.**
The Alembic migration hardcodes `{"high": "qwen2.5:14b-instruct-q8_0", "medium": "qwen2.5:14b-instruct-q8_0"}` inline (migrations must describe historical state, same convention already used in `20260523_0005_add_auto_approve_rules.py` for the DocumentType enum) rather than importing `quality.py` at migration time — importing live application code from a migration is fragile once that code is deleted in a later change. `add_column` with a `server_default` isn't enough here because the mapping is non-trivial (both old values collapse to the same new value coincidentally, but the migration should read as "translate old tier to old current model", not assume they're always equal); use `op.execute` with an `UPDATE ... CASE` (or two `UPDATE` statements) after the rename.

**3. Response schema split: public endpoints return `{model: str}`; the auto-tagger-facing internal endpoint keeps `{quality: <model tag echoed>, ollama_model: <model tag>}` for backward compatibility.**
`LLMSettings` (used by `GET/PATCH /settings/llm`, `/settings/answer-llm`) becomes `{model: str}` — `quality` and the redundant `ollama_model` duplicate field are dropped from the *public* shape, since there's no tier to distinguish from the model anymore. But `GET /api/settings/active-llm-model` (internal, consumed by `backend_provider.py`) is auto-tagger's wire contract and that code does `body.get("ollama_model")` — so that one response keeps an `ollama_model` key holding the model tag. Simplest implementation: give the internal endpoint its own tiny response model (`{ollama_model: str}`) rather than reusing `LLMSettings`, decoupling the internal contract from the public one so future public-shape changes can't accidentally break the auto-tagger.

**4. `GET /api/settings/available-models` is auth-gated (SPA-only), separate from the secret-gated internal endpoints.**
It's a UI convenience (populate a dropdown), not something the auto-tagger needs — no reason to expose it unauthenticated. Calls `ollama.AsyncClient(host=settings.ollama_base_url).list()` with a short timeout (~3s, matching the auto-tagger's `_resolve_ollama_model` 2s pattern); on any exception or when `settings.llm_backend != "ollama"`, returns `{models: []}` (HTTP 200, not an error) — the SPA treats an empty list as "show a free-text fallback" rather than surfacing a scary error banner for what's often a transient/expected condition.

**5. `PATCH /settings/llm` validator drops the closed-enum check, keeps only "non-empty string, reasonable length" validation.**
`LLMSettingsUpdate.model` must be non-empty and ≤128 chars (matching the new column width) — no membership check against any list, live or hardcoded. This is a deliberate behavior change from today's closed `{"high","medium"}` enum.

**6. SPA: dropdown backed by the live list, falling back to a plain text input when the list is empty.**
`useAvailableModels()` query hook (new, in `lib/settings.ts`) with a short `staleTime` (e.g. 10s — cheap call, and the operator might `ollama pull` something mid-session and expect it to show up on next page load). `ModelPicker` renders a `<select>` when `models.length > 0` (current stored value included as an option even if it's not in the live list, e.g. stale/never-pulled, so the UI never silently discards the saved value); renders a `<input type="text">` pre-filled with the current value when the list is empty. Both paths call the same mutation.

## Risks / Trade-offs

- **[Risk] Breaking change to `GET/PATCH /settings/llm` response shape (`quality` field removed)** → Mitigation: this is an internal-app API with exactly one consumer (the SPA), shipped and deployed together in the same repo/release — no external API consumers exist to break. Documented as **BREAKING** in the proposal for changelog visibility, not because of real compat risk.
- **[Risk] Migration backfill silently no-ops or errors on an install whose `llm_quality` column already contains something other than `"high"`/`"medium"` (e.g. hand-edited via psql)** → Mitigation: the `UPDATE` migration's `CASE` has an `ELSE` branch that passes the existing value through unchanged (best-effort — if someone hand-set it to a real model tag already, that's actually the desired end state).
- **[Risk] Ollama unreachable when the SPA loads Settings** → Mitigation: covered by decision 4 (graceful empty list, not an error), decision 6 (text-input fallback still lets the operator save a value blind).
- **[Trade-off] No server-side validation that a saved model tag is actually pulled** → Accepted per non-goals; matches the project's existing philosophy for `OLLAMA_MODEL` (documented gotcha: a bad tag surfaces as a 404 at extraction time, not at save time).

## Migration Plan

1. Alembic migration `0006_rename_quality_to_model.py`: rename `llm_quality`→`llm_model`, `answer_llm_quality`→`answer_llm_model`, widen both to `String(128)`, `UPDATE` existing rows translating `"high"`/`"medium"` → `"qwen2.5:14b-instruct-q8_0"` (else pass through unchanged). Runs automatically via the container entrypoint's `alembic upgrade head` — no manual operator step.
2. Ship backend (schemas/service/router/quality-module removal) and frontend changes together in the same PR/commit — the API contract change is only ever consumed by the co-deployed SPA, so there's no valid intermediate state to support.
3. `downgrade()` reverses the rename and best-effort maps any non-tier value back to `"high"` (lossy but the tier system is being retired, not preserved indefinitely — good enough for the rare manual-rollback case).

## Open Questions

None — scope was confirmed with the user (live Ollama-backed dropdown; extraction and answer models stay independently selectable).
