# aktenraum

A self-hosted, privacy-preserving document management system built on [Paperless-ngx](https://docs.paperless-ngx.com/), extended with an AI classification and extraction layer.

Every document you scan or drop into the consume folder is automatically classified, dated, and summarised in German — with suggestions waiting for your confirmation before anything is written as authoritative metadata.

**Status**: v1 in progress — Paperless deployment + auto-tagger service.

---

## What's here

```
docker/             Paperless-ngx Docker Compose stack
services/
  auto-tagger/      Python polling service: classifies docs via LLM, writes Paperless custom fields
apps/
  web/              Placeholder — future custom React/Next.js frontend (not implemented)
docs/
  adr/              Architecture Decision Records
  runbooks/         Step-by-step operational guides
scripts/            setup.sh, backup.sh, bootstrap-paperless.sh
openspec/           Design artifacts (proposal, design, specs, tasks)
```

---

## Getting started

Follow the **[First-time setup runbook](docs/runbooks/first-time-setup.md)**.

The short version:
1. Clone this repo
2. Run `bash scripts/setup.sh` to create host directories under `~/aktenraum/`
3. Copy `docker/.env.example` → `docker/.env` and fill in the required values
4. Copy `docker/auto-tagger.env.example` → `docker/auto-tagger.env` and set `ANTHROPIC_API_KEY`
5. `cd docker && docker compose up -d`
6. Run `bash scripts/bootstrap-paperless.sh` to create AI custom fields and tags
7. Drop a PDF into `~/aktenraum/consume/` and watch it appear in Paperless

---

## Backup

Backups run daily via systemd timer. See [restore runbook](docs/runbooks/restore.md) for recovery steps. **Do not skip the backup setup step.**

---

## Architecture decisions

See [`docs/adr/`](docs/adr/) for recorded decisions. Start with [ADR-001](docs/adr/001-monorepo-tooling.md).

---

## Out of scope in v1

- Custom frontend (placeholder workspace only)
- Semantic search / RAG
- Multi-user support
- Ollama performance tuning (the backend works; it's not tested)
- HTTPS / Tailscale (see TODO in first-time setup runbook)
