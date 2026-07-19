## Why

The LLM model used for extraction and for Ask-AI answers is chosen through a hardcoded 2-tier "quality" abstraction (`high` / `medium` in `aktenraum_api/settings/quality.py`) that today both point at the same model (`qwen2.5:14b-instruct-q8_0`). Picking a different locally-pulled Ollama model (e.g. `gemma4:e4b`) requires editing Python source and rebuilding the `aktenraum-api` container — there is no way to see what models are actually pulled or switch between them from the Settings page. This blocks the operator from experimenting with model quality/speed tradeoffs, which the project explicitly wants to support (per `docker/.env.example`'s per-host model tuning story).

## What Changes

- Add `GET /api/settings/available-models` (auth-gated): queries Ollama's `/api/tags` via the existing `ollama` client library and `Settings.ollama_base_url`, returns the locally-pulled model tags. Returns an empty list (not an error) when `LLM_BACKEND=anthropic` or when Ollama is unreachable — the endpoint degrades gracefully rather than failing the whole Settings page.
- **BREAKING**: `AppSettings.llm_quality` / `AppSettings.answer_llm_quality` DB columns are renamed to `llm_model` / `answer_llm_model` and change meaning from a symbolic tier (`"high"`/`"medium"`) to a literal Ollama model tag (e.g. `"qwen2.5:14b-instruct-q8_0"`). An Alembic migration backfills existing rows using the current `QUALITY_TO_MODEL` mapping as the one-time translation table, then the tier abstraction is deleted from the codebase (`settings/quality.py`'s `QUALITY_TO_MODEL` / `resolve_model` are removed; call sites read the stored model string directly).
- `PATCH /api/settings/llm` and `PATCH /api/settings/answer-llm` accept any non-empty model-tag string instead of validating against the closed `{"high", "medium"}` enum — the operator can type/select any tag they've pulled. No live validation against Ollama's model list at save time (avoids blocking a save when Ollama is briefly unreachable); a bad tag surfaces at extraction time the same way it does today via `OLLAMA_MODEL`.
- `GET /api/settings/active-llm-model` / the answer-model equivalent (consumed by the auto-tagger, secret-gated) keep their existing response shape but now return the raw stored model string with no tier indirection.
- SPA `Settings.tsx`: replace the hardcoded two-option radio picker (`OPTIONS` array) with a `<select>` populated from `GET /api/settings/available-models`, for both the extraction and answer model pickers independently (same two-picker layout as today). Falls back to a plain text input (or shows the currently-saved value read-only with a warning) when the model list comes back empty.
- `auto-tagger`'s `OLLAMA_MODEL` / `OLLAMA_ANSWER_MODEL` env vars are unchanged — they remain the fallback used only when the api is unreachable at request time, per the existing documented behavior.
- CLAUDE.md's "live LLM model is the DB quality-tier map, NOT `OLLAMA_MODEL`" gotcha row is rewritten to describe the new model-selection source of truth once implemented (tracked as a task, not part of this proposal).

## Capabilities

### New Capabilities

- `llm-model-settings`: operator-facing selection of the concrete Ollama model used for extraction and for Ask-AI answers, backed by a live query of locally-pulled models, replacing the fixed quality-tier abstraction.

### Modified Capabilities

(none — no existing `openspec/specs/` capability covers LLM model selection today; this is a new capability)

## Impact

- **Code**: `services/aktenraum-api/src/aktenraum_api/settings/{quality.py,schemas.py,service.py,router.py}`, `services/aktenraum-api/src/aktenraum_api/db/models.py` (`AppSettings` columns), new Alembic migration under `services/aktenraum-api/alembic/versions/`, `apps/web/src/routes/Settings.tsx`, `apps/web/src/lib/settings.ts` (types + query hooks).
- **APIs**: new `GET /api/settings/available-models`; response shape of `GET/PATCH /api/settings/llm` and `/answer-llm` changes from `{quality, ollama_model}` to `{model}` (or similar) — SPA and any other consumer must update together. `GET /api/settings/active-llm-model` (auto-tagger-facing) keeps a compatible shape.
- **DB**: `AppSettings` schema migration (column rename + data backfill) — must be backward-safe for existing installs (the migration runs automatically via the container entrypoint's `alembic upgrade head`).
- **Docs**: CLAUDE.md known-gotchas table update in the same commit per the project's documentation cadence; session note at `docs/sessions/YYYY-MM-DD.md`.
- **Out of scope**: Anthropic backend model selection, auto-approve rules, confidence-routing pipeline — all unchanged.
