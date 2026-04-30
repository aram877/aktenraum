## MODIFIED Requirements

### Requirement: Python version is pinned for the auto-tagger
The repository root SHALL contain a `pyproject.toml` declaring a uv workspace with members `services/auto-tagger` and `packages/aktenraum-core`. A single `uv.lock` SHALL exist at the workspace root and SHALL define all Python dependencies deterministically across both members. The `services/auto-tagger/` directory SHALL retain its `.python-version` file specifying the exact Python minor version.

#### Scenario: uv sync from the workspace root reproduces the environment
- **WHEN** `uv sync` is run at the repository root
- **THEN** it creates a single virtual environment containing exactly the locked dependency versions for both `auto-tagger` and `aktenraum-core`

#### Scenario: Per-service uv.lock no longer exists
- **WHEN** `services/auto-tagger/` is inspected
- **THEN** no `uv.lock` file is present at that path; the lockfile lives at the repository root
