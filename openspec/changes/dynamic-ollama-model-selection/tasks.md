## 1. Database migration

- [x] 1.1 Add `services/aktenraum-api/alembic/versions/20260719_0006_rename_quality_to_model.py`: rename `app_settings.llm_quality` → `llm_model`, `app_settings.answer_llm_quality` → `answer_llm_model`, widen both columns to `String(128)`.
- [x] 1.2 In the same migration's `upgrade()`, `UPDATE` existing rows translating `'high'`/`'medium'` → `'qwen2.5:14b-instruct-q8_0'` (inline hardcoded translation table per the historical-state convention used in `20260523_0005_add_auto_approve_rules.py`), passing any other existing value through unchanged.
- [x] 1.3 Write `downgrade()`: reverse the rename, best-effort map any non-tier value back to `'high'`.
- [x] 1.4 Update `AppSettings` model in `services/aktenraum-api/src/aktenraum_api/db/models.py`: rename `llm_quality`→`llm_model`, `answer_llm_quality`→`answer_llm_model`, `String(16)`→`String(128)`, update the class docstring/comments to describe literal model tags instead of symbolic tiers.

## 2. Backend: settings module

- [x] 2.1 Delete `services/aktenraum-api/src/aktenraum_api/settings/quality.py` (`QUALITY_TO_MODEL`, `resolve_model`, `Quality`, `QUALITIES`, `DEFAULT_QUALITY`) — confirm no remaining imports before deleting (grep after each following step).
- [x] 2.2 Add a module-level `DEFAULT_MODEL = "qwen2.5:14b-instruct-q8_0"` constant (new home — e.g. in `settings/schemas.py` or a small `settings/defaults.py`) used as the seed default in place of `DEFAULT_QUALITY`.
- [x] 2.3 Update `services/aktenraum-api/src/aktenraum_api/settings/schemas.py`: replace `LLMSettings{quality, ollama_model}` with `LLMSettings{model: str}`; replace `LLMSettingsUpdate`'s enum-membership validator with a non-empty/≤128-char validator.
- [x] 2.4 Add a separate small response schema for the internal endpoint, e.g. `ActiveModelResponse{ollama_model: str}`, preserving the exact field name `ollama_model` that `auto_tagger/backend_provider.py::_resolve_ollama_model` already parses.
- [x] 2.5 Update `services/aktenraum-api/src/aktenraum_api/settings/service.py`: rename `get_active_quality`/`set_active_quality`/`get_active_model` → model-based equivalents (e.g. `get_active_model`/`set_active_model`) reading/writing `llm_model`; same for the answer variants; drop the `QUALITY_TO_MODEL` membership checks (validation now lives only in the Pydantic schema).
- [x] 2.6 Update `services/aktenraum-api/src/aktenraum_api/settings/router.py`: `GET/PATCH /settings/llm` and `/settings/answer-llm` now return `LLMSettings{model}`; `GET /settings/active-llm-model` returns the new `ActiveModelResponse{ollama_model}` (same URL, same auth pattern — auth-less + secret header check unchanged).
- [x] 2.7 Add `GET /api/settings/available-models` (auth-gated via `get_current_user`): when `settings.llm_backend == "ollama"`, calls `ollama.AsyncClient(host=settings.ollama_base_url).list()` with a ~3s timeout inside a try/except; returns `{models: [...]}` on success, `{models: []}` on any exception or when the backend isn't ollama. Add response schema (e.g. `AvailableModelsResponse{models: list[str]}`) in `schemas.py`.

## 3. Backend: tests

- [x] 3.1 Update `services/aktenraum-api/tests/test_settings_router.py` for the new `{model}` request/response shape on `/settings/llm` and `/settings/answer-llm`; remove assertions tied to the `{"high","medium"}` enum; add a case asserting an arbitrary model string (e.g. `"gemma4:e4b"`) round-trips.
- [x] 3.2 Add tests for `GET /api/settings/active-llm-model` asserting the response still has an `ollama_model` key with the stored model tag.
- [x] 3.3 Add tests for `GET /api/settings/available-models`: success path (mocked Ollama client returns tags), unreachable-Ollama path (exception → empty list, HTTP 200), non-ollama-backend path (empty list without calling Ollama), unauthenticated path (401).
- [x] 3.4 Add/adjust a validator test for empty-string and >128-char rejection on `PATCH /settings/llm`.
- [ ] 3.5 Run `uv run pytest` from repo root (aktenraum-api + auto-tagger + aktenraum-core) — auto-tagger's existing `backend_provider` tests must pass unmodified since its wire contract didn't change.

## 4. Frontend: data layer

- [x] 4.1 Update `apps/web/src/lib/settings.ts`: replace `LLMQuality` type + `LLMSettings{quality, ollama_model}` with `LLMSettings{model: string}`; update `fetchLLMSettings`/`patchLLMSettings`/`fetchAnswerLLMSettings`/`patchAnswerLLMSettings` and their mutation hooks to send/receive `{model}` instead of `{quality}`.
- [x] 4.2 Add `useAvailableModels()` query hook calling `GET /settings/available-models`, short `staleTime` (~10s), returning `string[]`.

## 5. Frontend: Settings page UI

- [x] 5.1 In `apps/web/src/routes/Settings.tsx`, remove the hardcoded `OPTIONS` array and the two-tier `ModelPicker` radio rendering.
- [x] 5.2 Build a new picker that: renders a `<select>` of `useAvailableModels()` results (plus the currently-active model as an option if not already present in the list) when the list is non-empty; renders a text `<input>` pre-filled with the current value when the list is empty; both call the existing update mutation on change/submit.
- [x] 5.3 Apply this picker independently to both the extraction-model section and the answer-model section (mirroring today's two independent `ModelPicker` instances).
- [ ] 5.4 Manually verify in the browser: with Ollama up, the dropdown lists real pulled tags and switching + saving persists across reload; simulate Ollama down (or point `OLLAMA_BASE_URL` at a bad host) and confirm the text-input fallback still lets a save go through.

## 6. Documentation

- [ ] 6.1 Update CLAUDE.md's known-gotcha row "The live LLM model is the DB quality-tier map, NOT `OLLAMA_MODEL`" to describe the new model-string-based source of truth (`app_settings.llm_model` / `answer_llm_model`, resolved directly — no tier indirection) and how the operator now picks a model (Settings page dropdown/text input) instead of editing `QUALITY_TO_MODEL`.
- [ ] 6.2 Update the "AI: Conversational answer" / relevant aktenraum-api notes section in CLAUDE.md if it references `quality.py` or the tier abstraction.
- [ ] 6.3 Write session note at `docs/sessions/2026-07-19.md` (or append if one exists) documenting the shipped change.
- [ ] 6.4 Update `docs/api-reference.md` for the changed `/settings/llm`, `/settings/answer-llm` response shapes and the new `/settings/available-models` endpoint.

## 7. Verification

- [ ] 7.1 `task lint` (ruff + eslint) clean.
- [ ] 7.2 `task test` (full suite) green.
- [ ] 7.3 `task api:rebuild` and confirm `alembic upgrade head` applies the new migration cleanly against the running dev DB (check logs for migration success, then verify `app_settings` row has `llm_model`/`answer_llm_model` populated with a concrete tag, not `high`/`medium`).
- [ ] 7.4 End-to-end: pull a second Ollama model (e.g. `ollama pull gemma3:4b` or whatever is available on the host), select it in Settings for the extraction model, upload a test document, confirm extraction succeeds using the newly selected model (check auto-tagger logs for the resolved model name).
