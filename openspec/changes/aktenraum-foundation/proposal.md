## Why

Personal documents (invoices, contracts, insurance, medical, tax) accumulate without structure, making retrieval slow and error-prone. Paperless-ngx provides a solid OCR and storage foundation, but its tagging and metadata workflow is fully manual. This project — **aktenraum** — adds an AI classification and extraction layer on top, so that every scanned PDF arrives pre-tagged, pre-dated, and pre-summarised, requiring only a human confirmation click rather than a full manual review. The timing is right: local LLMs (Ollama) are now capable enough for German-language document classification, and the Paperless REST API is stable enough to treat it as a platform.

## What Changes

- **New monorepo scaffolded** at the project root using **pnpm workspaces** (no Turborepo/Nx — unnecessary orchestration overhead at this scale). Node 22 LTS pinned via `.nvmrc`.
- **Paperless-ngx deployed** via a single `docker/docker-compose.yml` with five services: paperless-ngx, postgres, redis, gotenberg, tika. All bound to `127.0.0.1` by default. Volumes mapped to explicit host paths under `~/aktenraum/`.
- **Restic backup system** configured from day one: daily snapshots of Paperless data + postgres dump, stored to a local repo (second disk), with optional B2/S3 remote. Scheduled via systemd timer.
- **Auto-tagger service** built in Python 3.13, living at `services/auto-tagger/`. Integrates with Paperless via **polling the REST API** (post-consume hook alternative considered but rejected — see §Capabilities). Supports two LLM backends (Anthropic API, Ollama) behind a common interface, switchable via `LLM_BACKEND` env var. Anthropic API is the v1 default (faster iteration); Ollama is supported behind the same interface and may be used without code changes, but is not heavily tested in v1.
- **Structured extraction** per document: `document_type` (enum: Rechnung, Vertrag, Behördenbrief, Versicherung, Mahnung, Kontoauszug, Garantie, Arztbrief, Steuer, Sonstiges), `correspondent`, `key_dates`, `monetary_amount`, `reference_numbers`, `suggested_tags`, `summary_de`. All stored as Paperless **custom fields**, plus an `ai-suggested` tag marking unconfirmed documents.
- **Documentation scaffolded**: root README, ADR template under `docs/adr/`, runbooks for setup / operations / restore / key rotation.
- **Frontend placeholder** created at `apps/web/` — empty Next.js workspace entry only, no implementation.

## Capabilities

### New Capabilities

- `repo-structure`: Monorepo layout, pnpm workspace config, tooling pins (Node, Python), root-level scripts and `.env.example` files.
- `paperless-deployment`: Docker Compose stack for Paperless-ngx (app + postgres + redis + gotenberg + tika), volume layout, environment variable catalogue, and networking defaults.
- `backup-system`: Restic-based backup scheme — what is backed up, when, where it goes, and how to restore. Includes the systemd unit files and a test-restore runbook.
- `auto-tagger`: The Python service that polls Paperless for new documents, calls the configured LLM backend, performs structured extraction, and writes results back as Paperless custom fields and tags.

### Modified Capabilities

*(none — this is a greenfield project)*

## Impact

- **External dependencies introduced**: Paperless-ngx (Docker image), postgres 15, redis 7, gotenberg, tika, restic, Python 3.13, Anthropic API (optional cloud), Ollama (optional local).
- **Data at rest**: All document content stays on-host. The only data leaving the machine is document text sent to the Anthropic API when `LLM_BACKEND=anthropic` — this is opt-in and documented explicitly.
- **Host requirements**: Linux, Docker + Compose v2, ~10 GB initial disk for images and data, a second disk or mount point for backup repo. RTX 4090 / 32 GB RAM assumed; Ollama local inference is viable but out of scope for v1.
- **Out of scope for v1**: custom frontend implementation, semantic search / RAG, embedding pipeline, multi-user support, mobile apps, Tailscale / reverse-proxy setup (noted as TODO in deployment docs), heavy Ollama testing (the abstraction exists; the test coverage does not).
