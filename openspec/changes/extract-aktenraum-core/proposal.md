## Why

The custom frontend roadmap (`docs/plans/custom-frontend.md`) introduces a second Python service — `aktenraum-api` — that needs the same LLM backends, Paperless API client, and shared Pydantic models the auto-tagger already has. Copy-pasting that code would be the wrong answer; growing the auto-tagger to also serve HTTP requests for the SPA would be the other wrong answer (different scaling envelope, different deployment cadence, different failure modes). The right answer is to extract a shared Python library and have both services depend on it.

This change does that extraction with zero behaviour change. It is foundational work for Phase 1 (`aktenraum-api-shell`) and beyond, and ships nothing user-visible on its own.

## What Changes

- **New uv workspace at the repository root** (`pyproject.toml` + `uv.lock` at root) declaring two members: `services/auto-tagger` and `packages/aktenraum-core`. The existing per-service lockfile under `services/auto-tagger/` is replaced by the workspace lockfile.
- **New `packages/aktenraum-core/` package** with `pyproject.toml` and `src/aktenraum_core/` containing three subpackages: `llm/` (Anthropic + Ollama backends + base protocol + factory), `paperless/` (the async client + lifecycle tag constants + value normalisers), and `models/` (`DocumentExtraction`, `DocumentType`, `KeyDates`, coercion validators).
- **`services/auto-tagger/` keeps only its own concerns**: extraction prompt and routing (`tagger.py`), propagation watcher (`propagator.py`), webhook handler (`webhook.py`), composition root (`main.py`), service-specific settings (`config.py`). All four import from `aktenraum_core` instead of relative paths for the moved modules.
- **`llm.factory.create_backend` is decoupled from auto-tagger's `Settings`**: the new core-level factory takes primitive parameters (backend name, model, base URL, API key) so any caller can use it without inheriting auto-tagger's config schema. A thin auto-tagger-side helper still bridges its `Settings` into those primitives.
- **CI workflow updated** to install and test from the workspace root rather than `cd`-ing into `services/auto-tagger/`. Both packages are linted and the auto-tagger's existing 97+ tests still run.
- **Auto-tagger Dockerfile updated** to build the workspace from the repo root (build context becomes `.` instead of `services/auto-tagger/`) so the core package is available inside the container.
- **CLAUDE.md updated** with the new layout and the workspace-root commands.

## Capabilities

### New Capabilities

- `aktenraum-core`: a shared Python library exposing LLM backends, the Paperless API client, and shared extraction models. Stable, semver-discipline-internal interface for consumption by `auto-tagger` today and `aktenraum-api` in Phase 1.

### Modified Capabilities

- `repo-structure`: the existing pnpm workspace declaration is joined by a uv workspace at the repo root. Python dependency management moves from per-service to workspace-wide.
- `auto-tagger`: the service no longer owns the LLM/Paperless/model code; it depends on `aktenraum-core` for those. Public behaviour is unchanged.

## Impact

- **No runtime behaviour change.** All existing tests must remain green; no env vars added or removed; no API surface changes; the running `auto-tagger` container produces identical extractions for identical inputs.
- **Build context change** for the auto-tagger Docker image — `docker compose up -d --build auto-tagger` now needs the repo root as context. The compose file is updated accordingly.
- **CI cache key** changes (was `services/auto-tagger/uv.lock`, now `uv.lock` at root). First post-merge CI run rebuilds the cache once.
- **Local developer workflow shifts** from `cd services/auto-tagger && uv sync` to `uv sync` at repo root, which now installs both packages. The auto-tagger Docker rebuild command is unchanged.
