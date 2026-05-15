# Configuration reference

Every env-var knob, organised by env file. All env files are gitignored;
each has a committed `.example` counterpart that
[`scripts/bootstrap-secrets.sh`](../scripts/bootstrap-secrets.sh) copies
and fills.

Three rules that bite:
- `docker compose restart` does **not** re-read env files. Use
  `docker compose up -d <service>` to recreate the container.
- Cross-file shared secrets (`PAPERLESS_DBPASS`, `WEBHOOK_SECRET`,
  `PAPERLESS_API_TOKEN`) must match across every file that names them.
  The bootstrap script reconciles them; if you edit by hand, do the same.
- Empty value ≠ unset. `KEY=` is treated as empty string by most readers
  here. The places where empty disables a feature (`QDRANT_URL`,
  `WEBHOOK_SECRET`, `AUTO_APPROVE_TYPES`) are flagged below.

---

## `docker/.env` — Paperless + compose

Shared by the `paperless`, `postgres`, and `nginx` services. The
`aktenraum-api` service also loads this file so `PAPERLESS_DB*` are
available to construct its DSN.

### Paperless core

| Var | Required | Default | Purpose |
|---|---|---|---|
| `PAPERLESS_SECRET_KEY` | yes | — | Django secret. Generate with `openssl rand -hex 32`. |
| `PAPERLESS_ADMIN_USER` | no | `admin` | Initial admin username. |
| `PAPERLESS_ADMIN_PASSWORD` | yes | — | Initial admin password. |
| `PAPERLESS_URL` | no | `http://localhost:8000` | Used by email links; no trailing slash. |

### Database

| Var | Required | Default | Purpose |
|---|---|---|---|
| `PAPERLESS_DBNAME` | no | `paperless` | Paperless DB name. |
| `PAPERLESS_DBUSER` | no | `paperless` | Postgres user owning both DBs. |
| `PAPERLESS_DBPASS` | yes | — | Postgres password. Shared with aktenraum-api. |

### Localisation

| Var | Default | Purpose |
|---|---|---|
| `TZ` | `Europe/Berlin` | Container timezone. |
| `PAPERLESS_OCR_LANGUAGE` | `deu+eng` | Tesseract language packs. |
| `PAPERLESS_DATE_ORDER` | `DMY` | Paperless date parser hint. |
| `PAPERLESS_DEFAULT_CURRENCY` | `EUR` | Default for `monetary` custom fields. |

### OCR

| Var | Default | Purpose |
|---|---|---|
| `PAPERLESS_OCR_ROTATE_PAGES` | `true` | Auto-rotate scanned pages with skew. |
| `PAPERLESS_OCR_ROTATE_PAGES_THRESHOLD` | `6` | Degrees of skew before rotation kicks in. |
| `PAPERLESS_OCR_OUTPUT_TYPE` | `pdfa` | Archival format. |
| `PAPERLESS_OCR_CLEAN` | `clean` | OCRmyPDF cleanup pass. |
| `PAPERLESS_OCR_DESKEW` | `true` | Run deskew before OCR. |
| `PAPERLESS_TASK_WORKERS` | `2` | OCR worker count. Tune to CPU. |
| `PAPERLESS_THREADS_PER_WORKER` | `1` | Threads per OCR worker. |

### Networking

| Var | Default | Purpose |
|---|---|---|
| `AKTENRAUM_WEB_PORT` | `8080` | Host port for nginx. The compose file publishes `127.0.0.1:${AKTENRAUM_WEB_PORT}:80`. |
| `PAPERLESS_ALLOWED_HOSTS` | (commented) | Uncomment + set when exposing beyond localhost. |
| `PAPERLESS_DISABLE_REGULAR_LOGIN` | `false` | Disables the standard login form (e.g. when behind SSO). |
| `PAPERLESS_ENABLE_COMPRESSION` | `true` | gzip Paperless's responses. |

### Webhook

| Var | Required | Default | Purpose |
|---|---|---|---|
| `WEBHOOK_SECRET` | no | empty | Shared secret between Paperless's `post_consume_script` and the auto-tagger. When non-empty, the script sends `X-Aktenraum-Secret: $WEBHOOK_SECRET` and the auto-tagger requires it to match. Empty disables auth. Must match `WEBHOOK_SECRET` in `auto-tagger.env`. |

---

## `docker/auto-tagger.env` — extraction worker

Loaded only by the `auto-tagger` service.

### Paperless connection

| Var | Required | Default | Purpose |
|---|---|---|---|
| `PAPERLESS_BASE_URL` | no | `http://paperless:8000` | In-network Paperless URL. |
| `PAPERLESS_API_TOKEN` | yes | — | Per-database. Mint via `POST /api/token/` after the first Paperless boot; persists across restarts but a fresh `pgdata/` invalidates it. **Must match the value in `aktenraum-api.env`.** |

### LLM backend

| Var | Required | Default | Purpose |
|---|---|---|---|
| `LLM_BACKEND` | no | `anthropic` | `anthropic` or `ollama`. |
| `ANTHROPIC_API_KEY` | if anthropic | — | From <https://console.anthropic.com>. |
| `ANTHROPIC_MODEL` | no | `claude-sonnet-4-6` | Anthropic model id. |
| `OLLAMA_BASE_URL` | no | `http://host.docker.internal:11434` | URL of the host's Ollama. |
| `OLLAMA_MODEL` | no | `qwen2.5:32b-instruct-q8_0` | Tag of a locally-pulled Ollama model. Recommend ≥14B Q8 for reliable structured output; smaller models drop schema fields. |

### Polling and routing

| Var | Default | Purpose |
|---|---|---|
| `POLL_INTERVAL_SECONDS` | `30` | How often the poller scans for missed webhook triggers. |
| `BATCH_SIZE` | `5` | Max docs the poller enqueues per scan. |
| `ENABLE_PROPAGATION` | `true` | Second polling loop that finds `ai-approved` → writes native fields → tag swap `ai-propagated`. |
| `AUTO_APPROVE_CONFIDENCE` | `0.90` | Confidence threshold for skipping the review queue. |
| `AUTO_APPROVE_TYPES` | empty | **Deprecated.** Legacy filter that gated auto-approve to specific doc types. The current code auto-approves on confidence alone; the env var is kept for legacy deployments and ignored by the routing logic. |
| `LOW_CONFIDENCE_THRESHOLD` | `0.6` | Extractions below this also get `ai-low-confidence` alongside `ai-pending`. |
| `FEW_SHOT_EXAMPLES` | `3` | Number of recently-propagated docs prepended as `(text excerpt, expected JSON)` examples. 0 disables. Each example adds ~500–700 tokens. |
| `USE_CORRESPONDENT_HISTORY` | `true` | When the doc mentions a known sender, prepend a hint naming the dominant past doc_type for that sender. |

### Webhook listener

| Var | Default | Purpose |
|---|---|---|
| `ENABLE_HTTP_SERVER` | `true` | Starts the aiohttp listener on `HTTP_PORT`. |
| `HTTP_PORT` | `8001` | In-network port for `POST /trigger/extract`. |
| `WEBHOOK_SECRET` | empty | Shared secret with Paperless's `post_consume_script`. Must match the value in `docker/.env`. Empty disables auth. |
| `MAX_TOKENS_INPUT` | `8000` | Token ceiling for document text (characters / 4 estimate). Longer docs are truncated with `[Dokument wurde aufgrund der Länge gekürzt.]`. |

### RAG indexing

| Var | Default | Purpose |
|---|---|---|
| `QDRANT_URL` | empty in template; defaults to `http://qdrant:6333` in compose | Where the indexer worker writes chunks. Empty disables indexing entirely. |
| `AKTENRAUM_API_URL` | `http://aktenraum-api:8002` | Used by pass 2 to store type-specific fields. |

### Logging

| Var | Default | Purpose |
|---|---|---|
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR`. |

---

## `docker/aktenraum-api.env` — application API

Loaded only by the `aktenraum-api` service. `DATABASE_URL` is built from
`PAPERLESS_DB*` in `docker/.env` via compose interpolation — only override
here for a non-default DSN.

### Auth

| Var | Required | Default | Purpose |
|---|---|---|---|
| `JWT_SECRET` | yes | — | HS256 signing key. Generate with `openssl rand -base64 32`. Missing/empty → service exits non-zero at startup. |
| `JWT_EXPIRES_SECONDS` | no | `28800` | Cookie lifetime (8h default). |
| `BOOTSTRAP_USERNAME` | no | `admin` | First-run user seed (ignored once the users table is non-empty). |
| `BOOTSTRAP_PASSWORD` | yes (first run) | — | Bootstrap user password. |
| `COOKIE_NAME` | no | `aktenraum_session` | Session cookie name. |
| `COOKIE_SECURE` | no | `false` | Set to `true` when the stack is behind HTTPS (Tailscale + caddy, etc.). |
| `LOG_LEVEL` | no | `INFO` | Service log level. |

### Paperless gateway

When `PAPERLESS_API_TOKEN` is unset, `/api/ai/*` and `/api/documents/*`
return 503; `/api/health` and `/api/auth/*` stay green.

| Var | Required | Default | Purpose |
|---|---|---|---|
| `PAPERLESS_BASE_URL` | no | `http://paperless:8000` | In-network Paperless URL. |
| `PAPERLESS_API_TOKEN` | for AI features | — | **Same value as in `auto-tagger.env`.** |
| `CORRESPONDENT_LIST_TTL_SECONDS` | no | `300` | How long the inlined correspondent list (used in the search prompt) is cached per worker. |

### Reprocess

| Var | Default | Purpose |
|---|---|---|
| `AUTO_TAGGER_URL` | `http://auto-tagger:8001` | aktenraum-api → auto-tagger webhook target for `/api/documents/{id}/reprocess`. |
| `WEBHOOK_SECRET` | empty | Same shared secret as elsewhere. Must match `auto-tagger.env`. |

### LLM backend (independent of auto-tagger)

The API has its own backend config so you can run a smaller/faster
model for filter extraction while the auto-tagger runs the same or
different model for full extractions.

| Var | Required | Default | Purpose |
|---|---|---|---|
| `LLM_BACKEND` | no | `anthropic` | `anthropic` or `ollama`. |
| `ANTHROPIC_API_KEY` | if anthropic | — | From console.anthropic.com. |
| `ANTHROPIC_MODEL` | no | `claude-sonnet-4-6` | Filter-extraction model. |
| `OLLAMA_BASE_URL` | no | `http://host.docker.internal:11434` | Host Ollama. |
| `OLLAMA_MODEL` | no | `qwen2.5:32b-instruct-q8_0` | Filter-extraction model. A smaller model is fine here if you split via `OLLAMA_ANSWER_MODEL`. |
| `OLLAMA_ANSWER_MODEL` | no | empty | Overrides `OLLAMA_MODEL` for the answer step in `/api/ai/answer/stream` only. Use a bigger model here (14B+); 8B reads citations unreliably. |
| `ANTHROPIC_ANSWER_MODEL` | no | empty | Same split for Anthropic. |

### RAG retrieval

| Var | Default | Purpose |
|---|---|---|
| `QDRANT_URL` | empty in template; defaults to `http://qdrant:6333` in compose | Vector store for query-time retrieval. Empty falls back to the AI-metadata-only path. |

---

## SPA dev server (`apps/web/.env*` or shell)

Two knobs honoured by [`apps/web/vite.config.ts`](../apps/web/vite.config.ts) at
`pnpm dev` / `task web:dev` time. Production builds ignore them.

| Var | Default | Purpose |
|---|---|---|
| `VITE_API_PROXY_TARGET` | `http://localhost:8080` | Where Vite proxies `/api/*`. Must match where nginx is published (the compose default is `:8080`, overridable via `AKTENRAUM_WEB_PORT` in `docker/.env`). |
| `VITE_HOST` | `0.0.0.0` | Vite bind address. The default exposes the dev server on the LAN so a second device can hit `http://<dev-machine-ip>:5173` with hot reload. Set to `127.0.0.1` if you want to limit it to the dev machine. |

Vite is also configured to accept any `Host` header (`allowedHosts: true`) so LAN hostnames / IPs don't 403 the way they would on a stock Vite 5+ setup.

To override either, drop a line like `VITE_API_PROXY_TARGET=http://localhost:9000` into `apps/web/.env.local` (gitignored) or export it in the shell before `task web:dev`.

---

## `docker/backup.env` — restic backup

Loaded only by the `backup` service.

| Var | Required | Default | Purpose |
|---|---|---|---|
| `RESTIC_PASSWORD` | yes | — | Passphrase that encrypts the restic repo. **You cannot restore without it.** Store in a password manager. |
| `PAPERLESS_DBUSER` | no | `paperless` | Postgres user for the live DB dump. Must match `docker/.env`. |
| `PAPERLESS_DBPASS` | yes | — | Postgres password. Must match `docker/.env`. |
| `BACKUP_B2_BUCKET` | no | empty | When set, snapshots are also copied to Backblaze B2. |
| `RESTIC_REPOSITORY_2` | no | — | B2 repo URL. Typically `b2:<bucket>:/aktenraum`. |
| `B2_ACCOUNT_ID` | no | — | B2 application key id. |
| `B2_ACCOUNT_KEY` | no | — | B2 application key. |

Schedule and retention are baked into [`docker/backup/crontab`](../docker/backup/crontab)
and [`docker/backup/entrypoint.sh`](../docker/backup/entrypoint.sh): daily
at 02:00, retention 7 daily / 4 weekly / 12 monthly.

---

## Pairing models for cost / quality

Recommended pairings for the AI features.

### Cloud-first

| Var | Value |
|---|---|
| `LLM_BACKEND` (both files) | `anthropic` |
| `ANTHROPIC_MODEL` (both files) | `claude-sonnet-4-6` |
| `ANTHROPIC_ANSWER_MODEL` (api only) | empty (reuse Sonnet for both) |

Best quality. Cost is roughly proportional to corpus turnover.

### Local-only

| Var | Value |
|---|---|
| `LLM_BACKEND` (both files) | `ollama` |
| `OLLAMA_MODEL` (both files) | `qwen2.5:32b-instruct-q8_0` |
| `OLLAMA_ANSWER_MODEL` (api only) | empty (reuse the 32B for both) |

Recommended sizing: `qwen2.5:32b-instruct-q8_0` (~32 GB RAM/VRAM) for
both extraction and answer. Schema adherence is dramatically better
than 8B and the JSON-truncation failure mode largely goes away.

If 32B doesn't fit, step down to `qwen2.5:14b-instruct-q8_0` (~16 GB) —
still a big jump from gemma4 8B for structured output. Going below
14B starts dropping `ai_title` / `ai_summary_de` / `confidence_reason`
reliably; the Python-side fallbacks catch this but the output is less
specific.

### Hybrid

`LLM_BACKEND=anthropic` in `auto-tagger.env` (cloud for classification
quality) + `LLM_BACKEND=ollama` in `aktenraum-api.env` (local for
streaming answers without per-query API cost).

---

## Where each file is loaded

```
docker/.env                  → paperless, postgres, nginx, aktenraum-api (for DSN)
docker/auto-tagger.env       → auto-tagger
docker/aktenraum-api.env     → aktenraum-api
docker/backup.env            → backup
```

Compose itself reads `docker/.env` for the variable substitutions in
`docker-compose.yml` (`${AKTENRAUM_WEB_PORT}`, `${PAPERLESS_DBPASS}`,
`${QDRANT_URL}`). That's why a `docker compose up` from outside the
`docker/` directory will not pick up `AKTENRAUM_WEB_PORT` — always
`cd docker/` first.
