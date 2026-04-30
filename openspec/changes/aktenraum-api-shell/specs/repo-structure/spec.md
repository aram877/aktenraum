## MODIFIED Requirements

### Requirement: pnpm workspace is configured
The repository SHALL declare pnpm workspaces covering `apps/*` and `services/*`. A root `package.json` with `"private": true` SHALL exist. Node version SHALL be pinned in `.nvmrc` at the root. The `apps/web/` workspace member SHALL be a real Vite + React + TypeScript project (replacing the v1 placeholder), reachable via `pnpm --filter @aktenraum/web <script>`.

#### Scenario: pnpm install succeeds from root
- **WHEN** `pnpm install` is run at the repository root
- **THEN** it completes without error and hoists shared dependencies, including for `@aktenraum/web`

#### Scenario: SPA build is invocable from the workspace root
- **WHEN** `pnpm --filter @aktenraum/web build` is run from the workspace root
- **THEN** the command produces a `dist/` directory under `apps/web/`

#### Scenario: Node version is discoverable
- **WHEN** a developer runs `node --version` after following the setup runbook
- **THEN** the version matches the value in `.nvmrc`

### Requirement: Python version is pinned for the auto-tagger
The repository root SHALL contain a `pyproject.toml` declaring a uv workspace with members `services/auto-tagger`, `services/aktenraum-api`, and `packages/aktenraum-core`. A single `uv.lock` SHALL exist at the workspace root and SHALL define all Python dependencies deterministically across all members. The `services/auto-tagger/` directory SHALL retain its `.python-version` file specifying the exact Python minor version.

#### Scenario: uv sync from the workspace root reproduces the environment
- **WHEN** `uv sync` is run at the repository root
- **THEN** it creates a single virtual environment containing exactly the locked dependency versions for `auto-tagger`, `aktenraum-api`, and `aktenraum-core`

#### Scenario: Per-service uv.lock no longer exists
- **WHEN** `services/auto-tagger/` or `services/aktenraum-api/` is inspected
- **THEN** no `uv.lock` file is present at either path; the lockfile lives at the repository root
