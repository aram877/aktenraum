## 1. Workspace Scaffold

- [ ] 1.1 Create root `pyproject.toml` declaring a uv workspace with members `packages/aktenraum-core` and `services/auto-tagger`. Workspace root has no project of its own.
- [ ] 1.2 Move `services/auto-tagger/uv.lock` → repo root. Run `uv sync` from the root to regenerate.
- [ ] 1.3 Add a top-level `[tool.ruff]` config that applies to both members; per-file `E501` ignore for `tagger.py` stays scoped to the auto-tagger pyproject.

## 2. aktenraum-core Package

- [ ] 2.1 Create `packages/aktenraum-core/pyproject.toml` (name: `aktenraum-core`, version `0.1.0`, deps: `pydantic`, `httpx`, `structlog`, `anthropic`, `ollama`).
- [ ] 2.2 Create `packages/aktenraum-core/src/aktenraum_core/__init__.py` (empty re-export module) and `py.typed` marker.
- [ ] 2.3 Create subpackages `llm/`, `paperless/`, `models/` each with an `__init__.py`.

## 3. Move LLM Backends

- [ ] 3.1 Move `services/auto-tagger/src/auto_tagger/llm/{base,anthropic_backend,ollama_backend}.py` → `packages/aktenraum-core/src/aktenraum_core/llm/`. Update intra-package relative imports.
- [ ] 3.2 Replace `services/auto-tagger/src/auto_tagger/llm/factory.py` with a new core-level `packages/aktenraum-core/src/aktenraum_core/llm/factory.py` that takes primitives (`name`, `anthropic_api_key`, `anthropic_model`, `ollama_base_url`, `ollama_model`) instead of a `Settings` object.
- [ ] 3.3 Re-export `LLMBackend`, `create_backend`, `AnthropicBackend`, `OllamaBackend` from `aktenraum_core.llm.__init__`.
- [ ] 3.4 Delete `services/auto-tagger/src/auto_tagger/llm/` entirely.

## 4. Move Paperless Client

- [ ] 4.1 Split `services/auto-tagger/src/auto_tagger/paperless.py` into `packages/aktenraum-core/src/aktenraum_core/paperless/client.py` (the `PaperlessClient` class + `LIFECYCLE_TAGS`) and `packages/aktenraum-core/src/aktenraum_core/paperless/normalisers.py` (`_normalize_date`, `_normalize_monetary`, `_truncate_string_field`, plus their private constants).
- [ ] 4.2 Re-export `PaperlessClient`, `LIFECYCLE_TAGS` from `aktenraum_core.paperless.__init__`. Normalisers stay accessible at `aktenraum_core.paperless.normalisers` for tests.
- [ ] 4.3 Delete `services/auto-tagger/src/auto_tagger/paperless.py`.

## 5. Move Shared Models

- [ ] 5.1 Move `services/auto-tagger/src/auto_tagger/models.py` → `packages/aktenraum-core/src/aktenraum_core/models/extraction.py`.
- [ ] 5.2 Re-export `DocumentExtraction`, `DocumentType`, `KeyDates`, `CoercedStr`, `CoercedList` from `aktenraum_core.models.__init__`.
- [ ] 5.3 Delete `services/auto-tagger/src/auto_tagger/models.py`.

## 6. Update Auto-Tagger

- [ ] 6.1 Add `aktenraum-core` as a workspace dependency in `services/auto-tagger/pyproject.toml` (`dependencies = ["aktenraum-core"]` + `[tool.uv.sources]` workspace mapping).
- [ ] 6.2 Rewrite imports in `tagger.py`, `propagator.py`, `webhook.py`, `main.py`: `from .models import …` → `from aktenraum_core.models import …`; `from .paperless import …` → `from aktenraum_core.paperless import …`; `from .llm.base import …` → `from aktenraum_core.llm import …`; `from .llm.factory import create_backend` → `from aktenraum_core.llm import create_backend`.
- [ ] 6.3 Update the `create_backend` call site in `main.py` to pass primitives from `Settings` rather than the `Settings` object itself.
- [ ] 6.4 Trim auto-tagger's direct dependencies (`anthropic`, `ollama`, `pydantic`, `httpx`, `structlog`) to whatever is still used directly; the rest become transitive via `aktenraum-core`.
- [ ] 6.5 Rewrite test imports in `tests/test_paperless.py`, `tests/test_models.py`, and the relevant parts of `tests/test_tagger.py` from `auto_tagger.X` to `aktenraum_core.X` for moved modules.

## 7. Dockerfile and Compose

- [ ] 7.1 Update `services/auto-tagger/Dockerfile` to build from a workspace-root context: copy root `pyproject.toml`, `uv.lock`, `packages/aktenraum-core/`, and `services/auto-tagger/`; run `uv sync --frozen --no-dev` at the root.
- [ ] 7.2 Update `docker/docker-compose.yml` `auto-tagger` service `build` block: `context: ..` (relative to `docker/`) and `dockerfile: services/auto-tagger/Dockerfile`.

## 8. CI

- [ ] 8.1 Update `.github/workflows/ci.yml` to drop `working-directory: services/auto-tagger` and run `uv sync` + `uv run ruff check` + `uv run pytest` from the repo root. Update `cache-dependency-glob` to `uv.lock` at root.
- [ ] 8.2 Confirm CI passes on the change branch before merging.

## 9. Verification

- [ ] 9.1 `uv sync` from repo root completes without errors.
- [ ] 9.2 `uv run pytest` from repo root passes all 97+ existing tests.
- [ ] 9.3 `uv run ruff check` from repo root passes.
- [ ] 9.4 `docker compose up -d --build auto-tagger` produces a running container; logs show normal startup (poller starting, http server starting on port 8001).
- [ ] 9.5 Trigger an extraction by clearing tags from one test document; verify it gets re-tagged with `ai-pending` (or auto-approve flow) within 30 s.

## 10. Documentation

- [ ] 10.1 Update `CLAUDE.md`: directory layout block now shows `packages/aktenraum-core/`; auto-tagger development workflow section now uses workspace-root commands.
- [ ] 10.2 Add a brief note in `docs/plans/custom-frontend.md` flipping Phase 0 from "in progress" to "done" once this change is archived.
