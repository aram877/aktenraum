## ADDED Requirements

### Requirement: Monorepo layout exists and is navigable
The repository SHALL follow the directory layout: `docker/`, `services/auto-tagger/`, `apps/web/`, `docs/adr/`, `docs/runbooks/`, `scripts/`. A root `README.md` SHALL explain the project purpose, status, and how to get started.

#### Scenario: Developer clones and orientates
- **WHEN** a developer clones the repository
- **THEN** the root `README.md` tells them what aktenraum is, what each top-level directory contains, and which runbook to follow for first-time setup

### Requirement: pnpm workspace is configured
The repository SHALL declare pnpm workspaces covering `apps/*` and `services/*`. A root `package.json` with `"private": true` SHALL exist. Node version SHALL be pinned in `.nvmrc` at the root.

#### Scenario: pnpm install succeeds from root
- **WHEN** `pnpm install` is run at the repository root
- **THEN** it completes without error and hoists shared dependencies

#### Scenario: Node version is discoverable
- **WHEN** a developer runs `node --version` after following the setup runbook
- **THEN** the version matches the value in `.nvmrc`

### Requirement: Python version is pinned for the auto-tagger
The `services/auto-tagger/` directory SHALL contain a `.python-version` file specifying the exact Python minor version (e.g. `3.13`). A `pyproject.toml` and `uv.lock` SHALL define all dependencies deterministically.

#### Scenario: uv sync reproduces the environment
- **WHEN** `uv sync` is run inside `services/auto-tagger/`
- **THEN** it creates a virtual environment with exactly the locked dependency versions

### Requirement: Gitignore covers all secrets and generated artefacts
A root `.gitignore` SHALL exclude: `*.env` files (except `*.env.example`), `__pycache__/`, `.venv/`, `node_modules/`, restic repo directories, and any postgres data directories.

#### Scenario: Committing after creating .env is safe
- **WHEN** a developer creates `docker/.env` from the example file and runs `git status`
- **THEN** `docker/.env` does not appear in the list of untracked files

### Requirement: ADR format is established
An ADR template SHALL exist at `docs/adr/000-template.md`. The first real ADR (001) SHALL record the monorepo tool choice. ADRs SHALL use a four-section format: Status, Context, Decision, Consequences.

#### Scenario: First ADR is present and follows the template
- **WHEN** a developer opens `docs/adr/001-monorepo-tooling.md`
- **THEN** it contains Status, Context, Decision, and Consequences sections and records the pnpm-workspaces decision
