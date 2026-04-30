## Context

The repository already uses two workspace-style tools: pnpm for `apps/*` and `services/*` (per the `aktenraum-foundation` change), and per-service `uv` for Python under `services/auto-tagger/`. As a second Python service joins, the per-service uv layout would either duplicate dependency resolution or require fragile path-dependency declarations. uv natively supports workspaces (workspace members share a single lockfile and resolution graph), which removes the friction.

The auto-tagger's three "library-shaped" modules — `llm/`, `paperless.py`, `models.py` — already have clean public interfaces and no upward dependencies on auto-tagger's runtime code, with one exception (`llm/factory.py` imports auto-tagger's `Settings`). That single coupling is broken in this change by giving the factory a primitive-argument signature.

## Goals / Non-Goals

**Goals:**
- One root-level `uv` lockfile that resolves dependencies across `auto-tagger` and `aktenraum-core` jointly.
- `aktenraum-core` is importable as `aktenraum_core` and exposes a stable public API surface.
- Auto-tagger's behaviour is bit-identical before and after the move (verified by the unchanged test suite).
- The auto-tagger Docker image still builds and the running container's behaviour is unchanged.

**Non-Goals:**
- Adding `aktenraum-api` (Phase 1's job).
- Adding the SPA, nginx, or any web tier (Phase 1's job).
- Splitting `aktenraum-core` into multiple packages — `llm/`, `paperless/`, `models/` are subpackages of one distribution, not three.
- Publishing `aktenraum-core` to a Python package index. It is workspace-internal and consumed via path dependency.

## Decisions

### D1 — One workspace lockfile at the repo root

`uv.lock` moves from `services/auto-tagger/` to the repo root. The root `pyproject.toml` is workspace-only (no project of its own), declaring members `packages/aktenraum-core` and `services/auto-tagger`. This matches the [uv workspaces](https://docs.astral.sh/uv/concepts/workspaces/) reference layout and means a single `uv sync` at the root installs everything.

Alternative considered: keep per-service lockfiles and use path dependencies (`aktenraum-core = { path = "../../packages/aktenraum-core" }`). Rejected — duplicates resolution work, and dependency upgrades in core require manually re-syncing every consumer.

### D2 — `aktenraum-core` is one distribution with subpackages

The package is `aktenraum_core` with `llm/`, `paperless/`, and `models/` as subpackages. Importers write `from aktenraum_core.llm import create_backend` or `from aktenraum_core.paperless import PaperlessClient`. Three separate distributions would imply they can evolve independently, which would be a fiction — they share Pydantic schemas (e.g. `DocumentExtraction` is consumed by the LLM backend and produced for the Paperless client) and version-locking them via three packages would just be ceremony.

### D3 — `paperless.py` becomes a `paperless/` subpackage

The current 397-line file is split into:
- `aktenraum_core/paperless/client.py` — the `PaperlessClient` class
- `aktenraum_core/paperless/normalisers.py` — `_normalize_date`, `_normalize_monetary`, `_truncate_string_field` (re-exported privately for tests)
- `aktenraum_core/paperless/__init__.py` — re-exports `PaperlessClient`, `LIFECYCLE_TAGS`

This is a minimal split (no logic change) that lets `aktenraum-api` import only what it needs and keeps the file under a reviewable size. The auto-tagger's existing test file `test_paperless.py` continues to import the normalisers — they stay accessible at `aktenraum_core.paperless.normalisers`.

### D4 — `models.py` becomes a `models/` subpackage

Similar move: `aktenraum_core/models/extraction.py` (everything currently in `models.py`) plus `aktenraum_core/models/__init__.py` re-exporting `DocumentExtraction`, `DocumentType`, `KeyDates`, `CoercedStr`, `CoercedList`. Future shared models (e.g. `SearchFilter` for Phase 2's `/api/ai/ask`) get their own files in this subpackage rather than swelling one.

### D5 — `llm/factory.py` takes primitives, not `Settings`

The current factory:
```python
def create_backend(settings: Settings) -> LLMBackend: ...
```
becomes:
```python
def create_backend(
    name: str, *,
    anthropic_api_key: str | None = None,
    anthropic_model: str = "claude-sonnet-4-6",
    ollama_base_url: str = "http://localhost:11434",
    ollama_model: str = "gemma2:latest",
) -> LLMBackend: ...
```

This is the only behaviour-relevant edit in the whole change. The auto-tagger keeps its existing `Settings`-driven call site by adapting at the boundary: `create_backend(s.llm_backend, anthropic_api_key=s.anthropic_api_key, ...)`. `aktenraum-api` will call the same factory with its own settings without inheriting any of the auto-tagger's config schema.

### D6 — Tests stay where they are; imports update

The auto-tagger's `tests/` directory keeps its tests for the moved modules (`test_paperless.py`, `test_models.py`, the relevant parts of `test_tagger.py`). Imports change from `auto_tagger.X` to `aktenraum_core.X` for moved code; locally-owned modules (`tagger`, `propagator`, `webhook`, `config`) keep their `auto_tagger.X` imports. Once `aktenraum-core` grows enough to deserve its own test suite (likely in Phase 1 when `aktenraum-api` adds new core-level features), those tests move into `packages/aktenraum-core/tests/`. We don't move them now to keep this change purely additive on the test side.

### D7 — Dockerfile build context expands to repo root

Today: `docker compose build auto-tagger` uses `services/auto-tagger/` as context, copying `pyproject.toml`, `uv.lock`, and `src/`. Post-change, the build needs `pyproject.toml` (root), `uv.lock` (root), `packages/aktenraum-core/`, and `services/auto-tagger/`. The compose build context becomes the repo root (`context: ..` from inside `docker/docker-compose.yml`), and the Dockerfile copies the workspace files explicitly.

Alternative considered: keep the build context narrow and pre-bundle `aktenraum-core` into a wheel before building. Rejected — it doubles the build steps and breaks the local dev story where editing `aktenraum-core` should propagate to the container on the next `docker compose up -d --build auto-tagger` without an extra publish step.

## Risks / Trade-offs

- **One bad refactor masquerades as zero behaviour change.** The whole change is moves + import rewrites; if a single import resolves to a stale shadow copy, behaviour drifts silently. Mitigations: delete the old files in the same commit as the move (no leftovers), CI runs the full test suite, and a manual `docker compose up -d --build auto-tagger` on a doc that exercises both extraction and propagation happens before this change is archived.
- **Workspace-root commands break muscle memory** (e.g. `cd services/auto-tagger && uv run pytest` no longer installs deps). CLAUDE.md is updated in the same change to reflect the new commands; the old form still runs tests after a workspace-root sync, just doesn't sync deps itself.
- **Dockerfile build context grows**, slightly enlarging the build cache footprint. Acceptable: `packages/aktenraum-core/src/` is a few KB.
- **The factory signature change is a Python-internal API break for anything (today: nothing) outside the auto-tagger.** Since auto-tagger is the only caller, the blast radius is one call site, updated atomically.

## Migration / Rollout

This is a single-commit refactor. There is no staged rollout — the move and the imports change together. Verification:
1. `uv sync` at the workspace root succeeds and installs both packages.
2. `uv run pytest` from the workspace root collects and passes the existing 97+ tests.
3. `uv run ruff check` from the workspace root passes for both packages.
4. `docker compose up -d --build auto-tagger` produces a running container that processes a test document end-to-end (extraction → tag → propagation when approved).

If verification fails: revert the commit. The change is mechanical enough that partial-success states should not exist.
