# Configuration reference

Every env-var knob in the stack. There is **one** env file:
`docker/.env` (gitignored), created from the committed template
`docker/.env.example` by
[`scripts/bootstrap-secrets.sh`](../scripts/bootstrap-secrets.sh), which
also fills every empty REQUIRED secret with `openssl rand` and prints the
generated passwords once.

Every service in [`docker/docker-compose.yml`](../docker/docker-compose.yml)
(`paperless`, `auto-tagger`, `aktenraum-api`, `backup`) loads that same file
via `env_file: .env`, and Compose reads it for `${…}` interpolation in the
compose file itself. A shared secret is therefore written once and cannot
drift between services.

Where values come from:

- **Template** — the value in `docker/.env.example`, i.e. what a fresh
  install runs with.
- **Code default** — what the service uses when the var is absent or empty.
  The Node services validate their env with zod at startup
  ([`services/auto-tagger/src/config.ts`](../services/auto-tagger/src/config.ts),
  [`services/aktenraum-api/src/config/settings.ts`](../services/aktenraum-api/src/config/settings.ts));
  an invalid value (non-number, out of range) aborts startup with
  `Invalid configuration — …`.

Rules that bite:

- `docker compose restart` does **not** re-read `docker/.env`. Use
  `docker compose --project-directory docker up -d <service>` (or
  `task start`) to recreate the container.
- Empty is treated as unset: `KEY=` falls back to the code default. Where
  empty *disables* a feature (`QDRANT_URL`, `WEBHOOK_SECRET`,
  `AKTENRAUM_MAIL_IMAP_SERVER`) it is called out below.
- Run compose from the repo root with `--project-directory docker`, or from
  inside `docker/`; otherwise Compose does not find `docker/.env` and the
  interpolated values (`AKTENRAUM_DATA_DIR`, ports, memory limits) are
  missing.

---

## Host, ports and resources (Compose interpolation)

Read by Compose when it renders `docker-compose.yml`, not by any service.

| Var | Template | Compose default | Purpose |
|---|---|---|---|
| `AKTENRAUM_DATA_DIR` | empty (**required**) | none — compose refuses to start | Absolute host path holding `data`, `media`, `export`, `consume`, `pgdata`, `qdrant`, `backup/restic-repo`. Never change it without migrating the directory first. |
| `AKTENRAUM_WEB_PORT` | commented out | `8080` | Host port for nginx, published as `127.0.0.1:${AKTENRAUM_WEB_PORT}:80`. |
| `AKTENRAUM_QDRANT_PORT` | commented out | `6333` | Host port for the Qdrant REST API (`127.0.0.1` only). |
| `AUTO_TAGGER_MEM_LIMIT` | `3g` | `3g` | `mem_limit` of the auto-tagger container. |
| `AKTENRAUM_API_MEM_LIMIT` | `6g` | `4g` | `mem_limit` of the aktenraum-api container (reranker + concurrent requests). |

---

## Paperless-ngx

Read by the `paperless` container. Any other
[Paperless-ngx setting](https://docs.paperless-ngx.com/configuration/) (for
example `PAPERLESS_ALLOWED_HOSTS` or `PAPERLESS_IGNORE_DATES`) can be added to
`docker/.env` and reaches the container the same way.

### Core and database

| Var | Template | Purpose |
|---|---|---|
| `PAPERLESS_SECRET_KEY` | empty (**required**, generated) | Django secret. |
| `PAPERLESS_ADMIN_USER` | `admin` | Initial admin username. Also read by `scripts/fix-token.sh` to mint the API token. |
| `PAPERLESS_ADMIN_PASSWORD` | empty (**required**, generated) | Initial admin password. |
| `PAPERLESS_URL` | `http://localhost:8000` | Public Paperless URL (used in links); no trailing slash. |
| `PAPERLESS_DBNAME` | `paperless` | Paperless database name. Also `POSTGRES_DB` for the postgres container. |
| `PAPERLESS_DBUSER` | `paperless` | Postgres user that owns both the `paperless` and `aktenraum` databases. |
| `PAPERLESS_DBPASS` | empty (**required**, generated) | Postgres password. Also used for `POSTGRES_PASSWORD`, the aktenraum-api `DATABASE_URL`, and the backup dumps. |

### Localisation and OCR

| Var | Template | Purpose |
|---|---|---|
| `TZ` | `Europe/Berlin` | Container timezone. |
| `PAPERLESS_OCR_LANGUAGE` | `deu+eng` | Tesseract language packs. |
| `PAPERLESS_DATE_ORDER` | `DMY` | Date parser hint. |
| `PAPERLESS_DEFAULT_CURRENCY` | `EUR` | Default for `monetary` custom fields. |
| `PAPERLESS_OCR_ROTATE_PAGES` | `true` | Auto-rotate skewed scans. |
| `PAPERLESS_OCR_ROTATE_PAGES_THRESHOLD` | `6` | Degrees of skew before rotation kicks in. |
| `PAPERLESS_OCR_OUTPUT_TYPE` | `pdfa` | Archive format. |
| `PAPERLESS_OCR_CLEAN` | `clean` | OCRmyPDF cleanup pass. |
| `PAPERLESS_OCR_DESKEW` | `true` | Deskew before OCR. |
| `PAPERLESS_TASK_WORKERS` | `2` | OCR worker count; tune to CPU. |
| `PAPERLESS_THREADS_PER_WORKER` | `1` | Threads per OCR worker. |
| `PAPERLESS_DISABLE_REGULAR_LOGIN` | `false` | Disables the standard Paperless login form. |
| `PAPERLESS_ENABLE_COMPRESSION` | `true` | gzip Paperless responses. |

Compose additionally sets `PAPERLESS_REDIS`, `PAPERLESS_DBHOST`, the Tika and
Gotenberg endpoints, `PAPERLESS_POST_CONSUME_SCRIPT` and
`AKTENRAUM_WEBHOOK_SECRET` (copied from `WEBHOOK_SECRET`, sent by
`post_consume.sh` as `X-Aktenraum-Secret`). Do not set these in `docker/.env`.

### Email ingestion (IMAP)

Read only by [`scripts/bootstrap-paperless.sh`](../scripts/bootstrap-paperless.sh),
which provisions a Paperless mail account + rule from them (idempotent; a
re-run reconciles drift). No service reads them at runtime.

| Var | Template | Purpose |
|---|---|---|
| `AKTENRAUM_MAIL_IMAP_SERVER` | empty | IMAP host. Empty skips mail setup entirely (an existing account is not deleted). |
| `AKTENRAUM_MAIL_IMAP_PORT` | `993` | IMAP port. |
| `AKTENRAUM_MAIL_IMAP_SECURITY` | `SSL` | `SSL`, `STARTTLS` or `NONE`. |
| `AKTENRAUM_MAIL_USERNAME` | empty | Mailbox login. |
| `AKTENRAUM_MAIL_PASSWORD` | empty | Mailbox password (Gmail: an App Password). |
| `AKTENRAUM_MAIL_FOLDER` | `INBOX` | Folder to poll. |
| `AKTENRAUM_MAIL_NAME` | `aktenraum` | Name of the Paperless mail account/rule. |
| `AKTENRAUM_MAIL_ACTION` | `MARK_READ` | What Paperless does with a consumed mail. |
| `AKTENRAUM_MAIL_FILTER_FROM` | empty | Optional sender filter. |

---

## Shared by auto-tagger and aktenraum-api

### Paperless connection

| Var | Template | Code default | Purpose |
|---|---|---|---|
| `PAPERLESS_BASE_URL` | `http://paperless:8000` | worker: none (**required**); api: `http://paperless:8000` | In-network Paperless URL. |
| `PAPERLESS_API_TOKEN` | empty | worker: none (**required** — the worker exits at startup without it); api: empty | Per-database token, minted after the first Paperless boot (`task setup` / `task recover`). A fresh `pgdata/` invalidates it. When empty, the api answers `/api/ai/*` and `/api/documents/*` with 503 while `/api/health` and `/api/auth/*` stay up. |

### Internal webhook secret

| Var | Template | Code default | Purpose |
|---|---|---|---|
| `WEBHOOK_SECRET` | empty (generated) | empty | Sent as `X-Aktenraum-Secret`. Gates the auto-tagger's `/trigger/*` endpoints (Paperless `post_consume`, api → worker triggers) and the api's internal `/api/settings/active-llm-model` + `/api/settings/active-auto-approve-rules` endpoints. Empty disables the check on both sides. |

### LLM backend

| Var | Template | Code default | Purpose |
|---|---|---|---|
| `LLM_BACKEND` | `ollama` | `anthropic` | `ollama` or `anthropic`. |
| `ANTHROPIC_API_KEY` | empty | empty | Required when `LLM_BACKEND=anthropic`; the api returns 503 for AI routes without it. |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | `claude-sonnet-4-6` | Anthropic model for extraction (worker) and filter extraction (api). |
| `ANTHROPIC_ANSWER_MODEL` | empty | empty | api only: overrides `ANTHROPIC_MODEL` for the `/ask` answer step. |
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434` | worker: `http://localhost:11434`; api: `http://host.docker.internal:11434` | Host Ollama. Also used for embeddings. |
| `OLLAMA_MODEL` | `qwen2.5:14b-instruct-q8_0` | `llama3.1:8b` | **Fallback only**, see below. |
| `OLLAMA_ANSWER_MODEL` | empty | empty | api only: when set, overrides the DB answer model for the `/ask` answer step. |

**Which Ollama model actually runs.** With `LLM_BACKEND=ollama` the live
models are the literal Ollama tags stored in the aktenraum database
(`app_settings.llm_model` for extraction/filter, `answer_llm_model` for
answers), picked in the SPA under `/settings` and seeded with
`qwen2.5:14b-instruct-q8_0`.

- aktenraum-api reads the DB setting directly and never reads `OLLAMA_MODEL`.
- The auto-tagger fetches `GET /api/settings/active-llm-model` (60 s cache,
  last good value reused on a blip) and falls back to `OLLAMA_MODEL` only
  when the api cannot be reached and nothing is cached
  (`active_llm_model_unreachable_using_env`).

With `LLM_BACKEND=anthropic` both services use `ANTHROPIC_MODEL` (plus
`ANTHROPIC_ANSWER_MODEL` for answers in the api); the DB setting is ignored.

### RAG

| Var | Template | Code default | Purpose |
|---|---|---|---|
| `QDRANT_URL` | `http://qdrant:6333` | empty | Qdrant REST URL. Empty disables RAG: the worker runs no indexer and the api answers from AI metadata only. |
| `EMBEDDING_MODEL` | `qwen3-embedding:4b` | `qwen3-embedding:4b` | Ollama embedding model, used for indexing (worker) and query embedding (api). Its dimension must match `rag.DENSE_DIM` in `@aktenraum/core` (2560); after changing it run `task rag:reembed`. Pull it first with `ollama pull`. |

### Logging

| Var | Template | Code default | Purpose |
|---|---|---|---|
| `LOG_LEVEL` | `INFO` | `INFO` | Structured JSON log level for both Node services. |

---

## auto-tagger (worker)

Validated in [`services/auto-tagger/src/config.ts`](../services/auto-tagger/src/config.ts).

### Loops and extraction

| Var | Template | Code default | Purpose |
|---|---|---|---|
| `POLL_INTERVAL_SECONDS` | `30` | `30` (min 5) | Interval of the extraction poller (safety net for missed webhooks) and the propagation poller. |
| `BATCH_SIZE` | `5` | `5` | Max docs the poller enqueues per scan. |
| `ENABLE_PROPAGATION` | `true` | `true` | Runs the loop that copies `ai-approved` docs to native Paperless fields and tags `ai-propagated`. |
| `LOW_CONFIDENCE_THRESHOLD` | `0.70` | `0.6` | Extractions below this get `ai-low-confidence` alongside `ai-pending` (when not auto-approved). |
| `FEW_SHOT_EXAMPLES` | `3` | `0` (max 5) | Number of recently propagated docs prepended as examples. `0` disables. Each adds roughly 500–700 tokens. |
| `USE_CORRESPONDENT_HISTORY` | `true` | `true` | Prepends a hint naming the dominant past doc type when the text mentions a known sender. |
| `MAX_TOKENS_INPUT` | `8000` | `12000` (min 1000) | Token ceiling for the document text (chars / 4 estimate); longer text is truncated. |
| `OLLAMA_NUM_CTX` | `24576` | `24576` | Context window requested for structured extraction calls. `0` leaves Ollama's server default (4–8k), which silently truncates the prompt. About 5 GB of KV cache for a 14B model. |
| `LLM_TIMEOUT_SECONDS` | `300` | `300` (min 10) | Aborts an extraction LLM call after this long. Timeouts and connection/429/5xx errors defer the doc (`extraction_deferred`) to the next poll; the third transient failure tags `ai-error`. |

### HTTP listener and api link

| Var | Template | Code default | Purpose |
|---|---|---|---|
| `ENABLE_HTTP_SERVER` | `true` | `true` | Starts the listener for `/trigger/*` and `/processing`. |
| `HTTP_PORT` | `8001` | `8001` | Internal-network port of that listener (never published). |
| `AKTENRAUM_API_URL` | `http://aktenraum-api:8002` | `http://aktenraum-api:8002` | Where the worker fetches auto-approve rules and the active model, and stores type-specific fields. |

**Auto-approve routing is not env-driven.** Per-`DocumentType` `enabled` +
`min_confidence` rules live in the `auto_approve_rules` table (seeded
disabled with `min_confidence = 0.90`), edited from
`/settings → Auto-Genehmigung`. The worker fetches them from
`GET /api/settings/active-auto-approve-rules` with a 60-second cache
([`services/auto-tagger/src/auto-approve-config.ts`](../services/auto-tagger/src/auto-approve-config.ts)).
If the api is unreachable and nothing is cached, every doc routes to
`ai-pending` with reason `rules_unreachable_fail_closed`.

---

## aktenraum-api

Validated in [`services/aktenraum-api/src/config/settings.ts`](../services/aktenraum-api/src/config/settings.ts).

### Database and server

| Var | Template | Code default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | not in template | none (**required**) | Set by Compose to `postgresql+asyncpg://${PAPERLESS_DBUSER}:${PAPERLESS_DBPASS}@postgres:5432/aktenraum`; the `+asyncpg` suffix is stripped before connecting. Do not set it in `docker/.env`. |
| `PORT` | not in template | `8002` | Listen port. |

### Auth

| Var | Template | Code default | Purpose |
|---|---|---|---|
| `JWT_SECRET` | empty (**required**, generated) | none (**required**) | HS256 signing key. Missing or empty aborts startup. |
| `JWT_EXPIRES_SECONDS` | `28800` | `28800` (min 60) | Session lifetime (8 h). |
| `BOOTSTRAP_USERNAME` | `admin` | empty | First-run user, inserted only while the `users` table is empty. |
| `BOOTSTRAP_PASSWORD` | empty (**required**, generated) | empty | Password for that user. |
| `COOKIE_NAME` | `aktenraum_session` | `aktenraum_session` | Session cookie name. |
| `COOKIE_SECURE` | commented out | `true` | Marks the cookie `Secure`. Set `false` only for plain-HTTP `http://localhost:8080` dev; for remote access use the Tailscale HTTPS URL instead. |

### Paperless, uploads and triggers

| Var | Template | Code default | Purpose |
|---|---|---|---|
| `CORRESPONDENT_LIST_TTL_SECONDS` | `300` | `300` | Cache lifetime of the correspondent list inlined into the search prompt. |
| `UPLOAD_MAX_FILE_BYTES` | not in template | `26214400` (25 MB) | Per-file upload limit. |
| `UPLOAD_MAX_FILES_PER_REQUEST` | not in template | `20` | Files per upload request. nginx separately caps the whole body at 500 MB. |
| `AUTO_TAGGER_URL` | `http://auto-tagger:8001` | `http://auto-tagger:8001` | Target of the best-effort `/trigger/extract`, `/trigger/propagate` and `/trigger/reindex-metadata` calls, and of the `/processing` lookup. |

### RAG retrieval

| Var | Template | Code default | Purpose |
|---|---|---|---|
| `RERANKER_MODEL` | not in template | `onnx-community/bge-reranker-v2-m3-ONNX` | Cross-encoder loaded by transformers.js and pre-warmed at startup. |
| `RAG_RETRIEVAL_TOP_K` | not in template | `50` (1–200) | Dense candidates fetched from Qdrant per question. |
| `RAG_RERANK_TOP_K` | not in template | `5` (1–50) | Chunks kept after reranking. |

Compose also sets `HF_HOME` and `HUGGINGFACE_HUB_CACHE` to the
`aktenraum-node-hf-cache` volume; the reranker uses
`TRANSFORMERS_CACHE` / `HUGGINGFACE_HUB_CACHE` / `HF_HOME` (first one set)
as its model cache so the download survives image rebuilds.

---

## backup

Read by [`docker/backup/entrypoint.sh`](../docker/backup/entrypoint.sh) and
[`docker/backup/verify-backup.sh`](../docker/backup/verify-backup.sh).
`PAPERLESS_DBUSER` / `PAPERLESS_DBPASS` come from the Paperless section above.

| Var | Template | Script default | Purpose |
|---|---|---|---|
| `RESTIC_PASSWORD` | empty (**required**, generated) | none | Encrypts the restic repo. **You cannot restore without it** — keep it in a password manager. |
| `RESTIC_REPOSITORY` | not in template | `/repo` | Repo path inside the container (bind-mounted from `${AKTENRAUM_DATA_DIR}/backup/restic-repo`). |
| `BACKUP_AUTO_INIT` | not in template | `false` | `true` lets the entrypoint `restic init` a missing repo. Otherwise it fails loudly; first-time init is done by `task setup`. |
| `BACKUP_FORCE_CHECK` | not in template | `false` | `true` runs the `restic check --read-data-subset=5%` on every run, not just Sundays. |
| `BACKUP_B2_BUCKET` | commented out | empty | When set (with the three vars below), snapshots are also copied to Backblaze B2. |
| `RESTIC_REPOSITORY_2` | commented out | empty | B2 repo URL, e.g. `b2:<bucket>:/aktenraum`. |
| `B2_ACCOUNT_ID` | commented out | empty | B2 application key id. |
| `B2_ACCOUNT_KEY` | commented out | empty | B2 application key. |

Schedule and retention are fixed in [`docker/backup/crontab`](../docker/backup/crontab)
and the entrypoint: daily at 02:00, keep 7 daily / 4 weekly / 12 monthly.

---

## SPA dev server (`apps/web/nuxt.config.ts`)

The Nuxt dev server reads no env vars. Its settings are fixed in code and
apply only to `task web:dev`; production builds (`nuxt generate`, baked into
the nginx image by `task build`) ignore them.

| Setting | Where | Value |
|---|---|---|
| `/api` proxy target | `nitro.devProxy` in `apps/web/nuxt.config.ts` | `http://localhost:8080/api`. Edit it if you change `AKTENRAUM_WEB_PORT`. |
| Bind address + port | `dev` script in `apps/web/package.json` | `--host 0.0.0.0 --port 4300` — reachable on the LAN at `http://<dev-machine-ip>:4300`. |

---

## Pairing models for cost / quality

Because both Node services read the same `LLM_BACKEND`, the backend is
always the same for extraction and Q&A; only the models differ.

### Local (template default)

| Setting | Value |
|---|---|
| `LLM_BACKEND` | `ollama` |
| Extraction model (`/settings`) | `qwen2.5:14b-instruct-q8_0` (~16 GB); `qwen2.5:32b-instruct-q8_0` (~32 GB) if it fits |
| Answer model (`/settings`, or `OLLAMA_ANSWER_MODEL`) | same model, or a bigger one (14B+) |
| `OLLAMA_MODEL` | same tag as the extraction model, so the worker's fallback matches |

Models of 8B and below drop schema fields (`ai_title`, `ai_summary_de`,
`confidence_reason`) and read citations unreliably; the worker's
synthesizer fallbacks fill some gaps but the output is less specific.

### Cloud

| Setting | Value |
|---|---|
| `LLM_BACKEND` | `anthropic` |
| `ANTHROPIC_API_KEY` | your key |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` |
| `ANTHROPIC_ANSWER_MODEL` | empty (reuse Sonnet) |

Best quality; cost scales with corpus turnover and question volume.
Embeddings and reranking stay local either way.
