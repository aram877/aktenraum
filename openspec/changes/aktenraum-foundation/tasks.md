## 1. Repository Scaffold

- [ ] 1.1 Initialise git repository at project root
- [ ] 1.2 Create root `.gitignore` covering `.env`, `__pycache__/`, `.venv/`, `node_modules/`, restic dirs, postgres data dirs
- [ ] 1.3 Create root `package.json` (`"private": true`, `"packageManager": "pnpm@9"`)
- [ ] 1.4 Create `pnpm-workspace.yaml` declaring `apps/*` and `services/*`
- [ ] 1.5 Create `.nvmrc` pinned to `22`
- [ ] 1.6 Create top-level directories: `docker/`, `services/auto-tagger/`, `apps/web/`, `docs/adr/`, `docs/runbooks/`, `scripts/`
- [ ] 1.7 Create root `README.md` with project overview, directory map, and link to first-time setup runbook
- [ ] 1.8 Create `docs/adr/000-template.md` with Status / Context / Decision / Consequences sections
- [ ] 1.9 Create `docs/adr/001-monorepo-tooling.md` recording the pnpm-workspaces decision
- [ ] 1.10 Create `apps/web/.gitkeep` and `apps/web/package.json` placeholder (name `@aktenraum/web`, private, no scripts yet)

## 2. Paperless-ngx Docker Deployment

- [ ] 2.1 Write `docker/docker-compose.yml` with services: `paperless`, `postgres`, `redis`, `gotenberg`, `tika` on an internal network; paperless bound to `127.0.0.1:8000`
- [ ] 2.2 Write `docker/.env.example` documenting all env vars with safe defaults (`TZ=Europe/Berlin`, `PAPERLESS_OCR_LANGUAGE=deu+eng`, `PAPERLESS_DATE_ORDER=DMY`, etc.), marking required vars
- [ ] 2.3 Write `scripts/setup.sh` that creates all `~/aktenraum/` subdirectories (`consume/`, `media/`, `data/`, `pgdata/`, `export/`, `backup/restic-repo/`) with correct permissions
- [ ] 2.4 Write `scripts/bootstrap-paperless.sh` that creates the 12 AI custom fields and 2 tags (`ai-suggested`, `ai-error`) via the Paperless REST API, idempotently
- [ ] 2.5 Write `docs/runbooks/first-time-setup.md` covering: clone repo, run `setup.sh`, copy `.env.example` to `.env`, fill required vars, `docker compose up -d`, run `bootstrap-paperless.sh`

## 3. Backup System

- [ ] 3.1 Write `scripts/backup.sh` that: initialises restic repo if absent, backs up `data/`, `media/`, `export/`, and postgres dump (stdin pipe), applies retention policy (7d/4w/12m), optionally syncs to B2 if `BACKUP_B2_BUCKET` is set
- [ ] 3.2 Write `docker/systemd/aktenraum-backup.service` and `aktenraum-backup.timer` (daily at 02:00)
- [ ] 3.3 Write `docs/runbooks/restore.md` covering: list snapshots, restore files, restore postgres dump, restart stack

## 4. Auto-tagger Service — Foundation

- [ ] 4.1 Create `services/auto-tagger/pyproject.toml` with dependencies: `anthropic`, `ollama`, `pydantic`, `httpx`, `python-dotenv`, `structlog`
- [ ] 4.2 Create `services/auto-tagger/.python-version` pinned to `3.13`
- [ ] 4.3 Run `uv lock` to generate `services/auto-tagger/uv.lock`
- [ ] 4.4 Create `services/auto-tagger/.env.example` documenting all env vars with defaults
- [ ] 4.5 Create package structure: `services/auto-tagger/src/auto_tagger/` with `__init__.py`, `config.py`, `models.py`, `paperless.py`, `llm/`, `tagger.py`, `main.py`

## 5. Auto-tagger Service — Models and Config

- [ ] 5.1 Implement `config.py`: load all env vars via Pydantic `BaseSettings`, validate required vars on startup
- [ ] 5.2 Implement `models.py`: `DocumentExtraction` Pydantic model with `document_type` enum (10 German values), all extraction fields, `confidence` float
- [ ] 5.3 Implement `paperless.py`: async `PaperlessClient` wrapping `httpx.AsyncClient` — `get_unprocessed_documents()`, `patch_document_fields()`, `add_tag()`, `get_or_create_tag()`

## 6. Auto-tagger Service — LLM Backends

- [ ] 6.1 Define `llm/base.py`: `LLMBackend` Protocol with `complete(messages, response_schema) -> BaseModel`
- [ ] 6.2 Implement `llm/anthropic_backend.py`: uses `anthropic` SDK, `claude-sonnet-4-6`, tool-use for structured output, converts `response_schema` to tool definition
- [ ] 6.3 Implement `llm/ollama_backend.py`: uses `ollama` Python client, JSON mode, validates response against `response_schema` via Pydantic
- [ ] 6.4 Implement `llm/factory.py`: returns the correct backend based on `LLM_BACKEND` env var

## 7. Auto-tagger Service — Tagger and Prompt

- [ ] 7.1 Write the German system prompt in `tagger.py` instructing the model to extract structured data using the 10 canonical `document_type` values
- [ ] 7.2 Implement text truncation in `tagger.py`: truncate OCR text at `MAX_TOKENS_INPUT * 4` characters, append truncation notice
- [ ] 7.3 Implement `tagger.py` main extraction flow: fetch text → call backend → validate → write custom fields → add `ai-suggested` tag; on validation error tag `ai-error` and log
- [ ] 7.4 Implement `main.py`: async polling loop, `POLL_INTERVAL_SECONDS`, `BATCH_SIZE`, structured logging via `structlog`

## 8. Auto-tagger Service — Docker Integration

- [ ] 8.1 Write `services/auto-tagger/Dockerfile`: multi-stage, Python 3.13 slim base, install via `uv sync --no-dev`, non-root user
- [ ] 8.2 Add `auto-tagger` service to `docker/docker-compose.yml`: build from `../services/auto-tagger`, `env_file: auto-tagger.env`, `depends_on: paperless`, `restart: unless-stopped`
- [ ] 8.3 Create `docker/auto-tagger.env.example` (symlink or copy of service `.env.example` for compose context)

## 9. Operations Runbooks

- [ ] 9.1 Write `docs/runbooks/operations.md`: starting/stopping the stack, viewing logs, dropping a document into consume, checking auto-tagger output, confirming AI suggestions (removing `ai-suggested` tag)
- [ ] 9.2 Write `docs/runbooks/rotate-api-keys.md`: steps to rotate Paperless secret key and Anthropic API key without data loss

## 10. Final Checks

- [ ] 10.1 Verify `docker compose config` validates the compose file without errors
- [ ] 10.2 Verify `pnpm install` succeeds from the repo root
- [ ] 10.3 Verify `uv sync` succeeds inside `services/auto-tagger/`
- [ ] 10.4 Verify `scripts/setup.sh` is executable and runs without error on Linux
- [ ] 10.5 Confirm all `.env.example` files are committed and all `.env` files are gitignored
- [ ] 10.6 Make initial git commit with the full scaffold
