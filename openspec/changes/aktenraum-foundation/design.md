## Context

Greenfield project. No existing codebase to migrate. The host is a personal Linux workstation (RTX 4090, 32 GB RAM) running Docker. All services bind to `127.0.0.1`; no external exposure in v1. The operator is a single person managing German-language personal documents.

The working directory (`D:\Development\document-organizer`) is the authoring environment on Windows; the monorepo is deployed and run on the Linux host. Paths in runbooks use Linux conventions; the repo itself is OS-agnostic.

## Goals / Non-Goals

**Goals:**
- Reproducible, code-defined deployment: no manual UI steps that aren't documented
- Every new Paperless document automatically classified and extracted within ~60 seconds of ingestion
- All suggested metadata requires explicit human confirmation before Paperless treats it as authoritative
- Backup runs unattended from day one; restore is tested and documented
- LLM backend is swappable via one env var, with no code changes

**Non-Goals:**
- Custom frontend (placeholder workspace only)
- Semantic search / RAG pipeline
- Multi-user, sharing, mobile
- Ollama performance tuning or test coverage in v1
- Tailscale / HTTPS / reverse proxy (TODO in runbook)
- GPU acceleration for local inference in v1

## Decisions

### D1 — Monorepo tool: pnpm workspaces (no Turborepo)

pnpm workspaces gives shared dependency hoisting and workspace-aware scripts with zero extra config. Turborepo adds build caching and task graphs — useful when you have multiple packages building in CI. At this scale (one Python service, one placeholder web app, shell scripts), the overhead isn't justified. We add Turborepo later if build times become a problem.

`pnpm-workspace.yaml` declares `apps/*` and `services/*`. The Python service (`services/auto-tagger`) is not a pnpm package — it's a workspace member only in the sense that it lives under a named directory; its own tooling is `uv` + `pyproject.toml`.

### D2 — Python tooling: uv + pyproject.toml (not pip/venv/Poetry)

`uv` is the fastest Python package manager as of 2025, with lockfile support (`uv.lock`), virtual env management, and a clean `pyproject.toml` interface. Poetry adds too much magic around publishing. Plain pip has no lockfile. `uv` pins everything deterministically and is the right choice for a service that needs reproducible installs.

Python version pinned to 3.13 via `.python-version` at the service root.

### D3 — Paperless integration: REST API polling (not post-consume hook)

**Options considered:**
1. *Post-consume hook script*: Paperless calls a script after OCR completes. Low latency, but requires the script to live inside the Paperless container (or on a shared volume), tightly coupling the auto-tagger deployment to the Paperless container lifecycle.
2. *Webhook listener*: Paperless doesn't natively emit webhooks. Would require a plugin or a reverse proxy shim. Too much friction.
3. *REST API polling*: The auto-tagger runs as an independent process and polls `GET /api/documents/?ordering=-created&page_size=20` every 30 seconds. Documents tagged `ai-suggested` are skipped. Untagged, unprocessed documents are picked up. Simple, decoupled, no shared filesystem required.

**Decision: polling.** The 30-second latency is acceptable for personal use. The auto-tagger is a completely independent service with no coupling to Paperless internals.

### D4 — LLM backend abstraction

A `LLMBackend` protocol (Python `Protocol` class) with a single method:
```
def complete(messages: list[Message], response_schema: type[BaseModel]) -> BaseModel
```

Two concrete implementations:
- `AnthropicBackend`: uses `anthropic` SDK, `claude-sonnet-4-6` model, structured output via tool use + Pydantic schema
- `OllamaBackend`: uses `ollama` Python client, structured output via JSON mode + Pydantic schema validation

Selected by `LLM_BACKEND=anthropic|ollama` env var. Both are present in the codebase in v1; Ollama is not covered by integration tests but is functionally wired.

### D5 — Structured extraction: Pydantic schema + tool use (Anthropic) / JSON mode (Ollama)

The extraction schema (a `DocumentExtraction` Pydantic model) is the single source of truth. The Anthropic backend converts it to a tool definition; Ollama receives it as a JSON schema in the system prompt. Validation happens on the Pydantic model in both cases — if the LLM output doesn't conform, the document is tagged `ai-error` and skipped (no crash).

`document_type` is a Python `Literal` / `Enum` constrained to:
`Rechnung | Vertrag | Behördenbrief | Versicherung | Mahnung | Kontoauszug | Garantie | Arztbrief | Steuer | Sonstiges`

### D6 — Human-in-the-loop state: Paperless custom fields + `ai-suggested` tag

**Options considered:**
1. *External SQLite*: fully decoupled, easy to query, but introduces a second source of truth that can drift from Paperless.
2. *`ai-suggested` tag only*: loses all structured extraction data until confirmed.
3. *Paperless custom fields + `ai-suggested` tag*: extraction results live in Paperless itself (visible in the UI immediately), `ai-suggested` marks them as pending confirmation, and removing the tag is the confirmation gesture.

**Decision: custom fields + tag.** Keeps everything in one place. The user sees the AI suggestions directly in the Paperless document detail view. Confirmation = remove `ai-suggested` tag (or a future UI button that does so via the API).

Custom fields to create in Paperless:
- `ai_document_type` (string)
- `ai_correspondent` (string)
- `ai_issue_date` (date)
- `ai_due_date` (date)
- `ai_expiry_date` (date)
- `ai_monetary_amount` (string, e.g. "149,99 EUR")
- `ai_reference_numbers` (string, comma-separated)
- `ai_suggested_tags` (string, comma-separated)
- `ai_summary_de` (text)
- `ai_confidence` (float, 0–1)
- `ai_backend` (string, "anthropic" or "ollama")
- `ai_model` (string, model name used)

### D7 — Backup: restic to local repo + optional B2 remote

**Restic over Borg:** restic has simpler CLI, native B2/S3 support without plugins, and is easier to script for unattended operation. Borg is faster for large archives but adds complexity for cloud remotes.

What is backed up:
1. `~/aktenraum/data/` — Paperless data directory
2. `~/aktenraum/media/` — document files (originals + thumbnails)
3. `~/aktenraum/export/` — Paperless export directory
4. Postgres dump (pg_dump piped directly into restic, no temp file on disk)

Schedule: daily via systemd timer (`aktenraum-backup.timer`). Retention: keep 7 daily, 4 weekly, 12 monthly snapshots. Local repo at `~/aktenraum/backup/restic-repo/`. Remote B2 bucket configured via `RESTIC_REPOSITORY_2` if `BACKUP_B2_BUCKET` env var is set.

### D8 — Volume layout

```
~/aktenraum/
├── consume/          # drop PDFs here for ingestion
├── media/            # Paperless stores processed docs here
├── data/             # Paperless internal data
├── export/           # manual exports
├── pgdata/           # postgres data directory
└── backup/
    └── restic-repo/  # local backup repository
```

All paths are created by `scripts/setup.sh` on first run.

### D9 — Environment variable strategy

Two `.env` files:
- `docker/.env.example` — committed, all vars with safe defaults and comments
- `docker/.env` — gitignored, operator-filled copy

The auto-tagger reads its own `services/auto-tagger/.env` (also gitignored), sourced from `services/auto-tagger/.env.example`.

No secrets in docker-compose.yml. All sensitive values (Paperless secret key, DB password, API keys) are env vars.

## Risks / Trade-offs

- **Polling latency**: 30-second poll interval means a newly consumed document may sit untouched for up to 30 seconds. Acceptable for personal use; reducible to 10 seconds with no code change.
- **Anthropic API cost**: Sending full document text (post-OCR) to the Anthropic API has a cost per document. For typical personal document volumes (<50 docs/month), this is negligible. Mitigated by: text truncation at 8,000 tokens, cost logging per run.
- **LLM hallucination on dates/amounts**: Pydantic validation catches type errors, but a plausible-looking wrong date won't be caught. Mitigated by: every field is "suggested, not applied" — the human confirmation step is the safety net.
- **Paperless custom field bootstrap**: The 12 custom fields must exist in Paperless before the auto-tagger can write to them. Mitigated by: `scripts/bootstrap-paperless.sh` creates them via the API on first run, documented in runbook.
- **Single-user assumption**: Custom fields and tag names are hardcoded. If multi-user is added later, the field naming scheme needs revisiting. Documented as a known limitation.

## Open Questions

- *(none blocking implementation)* Paperless-ngx version to pin: use latest stable at time of initial deploy, document the pinned version in `docker/.env.example`.
- *(post-v1)* Whether to expose a lightweight confirmation UI before building the full React frontend — a simple FastAPI endpoint + htmx page could serve as an interim review screen.
