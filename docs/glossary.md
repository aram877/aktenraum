# Glossary

Plain-language definitions for every acronym, framework, and piece of jargon that shows up in this repo. Read top-to-bottom or `Ctrl+F` for a specific term. When two terms get confused (SSE vs. SIGTERM, RAG vs. LLM, TOCTOU vs. race condition), the entry says so.

> **How to use this file**: if you see a term in `CLAUDE.md`, a session note, an ADR, or a code comment and you're not sure what it means, it should be here. If it isn't, the file's wrong — open a PR.

---

## Project & domain

- **aktenraum** — the product. German: "Aktenraum" = "file room." A self-hosted personal document management system (DMS) for German bureaucratic paperwork (tax, medical, insurance, etc.).
- **Paperless / Paperless-ngx** — the open-source DMS we build on top of. Handles OCR, storage, and the document UI for power users. Our auto-tagger + aktenraum-api + SPA are the AI + product layer on top.
- **DMS** — Document Management System. Paperless and aktenraum are both DMSes.
- **Korrespondent / Correspondent** — German term Paperless uses for "sender or issuer of the document" (your bank, the tax office, your employer).
- **Bescheid** — German for "official ruling/notice issued by an authority." Many of our document types use this word (Steuerbescheid, Rentenbescheid, …).
- **OpenSpec** — the workflow we use for non-trivial changes: a proposal/design/specs/tasks scaffold before implementation. Lives under `openspec/changes/`.
- **ADR** — Architecture Decision Record. A short markdown doc capturing a binding design decision and the reasoning behind it. Numbered (`docs/adr/001-…`, `002-…`, etc.). See `docs/adr/000-template.md`.

---

## Stack & infrastructure

- **Docker Compose** — the tool that runs all 10 services (Paperless, Postgres, Redis, Qdrant, auto-tagger, aktenraum-api, nginx, gotenberg, tika, backup) from one `docker/docker-compose.yml` file. `task up` starts them.
- **container** — an isolated process running one service. Each row of `docker compose ps` is a container.
- **service** — a logical role in `docker-compose.yml` (e.g. `paperless`, `qdrant`). Maps 1:1 to a container in our setup.
- **healthcheck** — a probe Docker runs against a container to mark it `(healthy)`. Used by `depends_on: service_healthy` to delay startup of dependent services.
- **bind mount / volume** — a host directory mapped into a container so data survives container restarts. Our bind mounts live under `${AKTENRAUM_DATA_DIR:-${HOME}/aktenraum}/`.
- **env file** — a `KEY=VALUE` text file Docker Compose loads into a service's environment. Each service has one (`docker/.env`, `auto-tagger.env`, `aktenraum-api.env`, `backup.env`). Per `ADR-002` they're not committed; `bootstrap-secrets.sh` generates them on first run.
- **Taskfile** — `Taskfile.yml` at repo root (https://taskfile.dev). Wraps every common workflow as a one-liner — `task up`, `task tagger:rebuild`, `task lint`, etc. `task --list` enumerates them.
- **uv** — fast Python package + venv manager (the `pip`/`venv`/`poetry` replacement we use). `uv sync` installs, `uv run pytest` runs.
- **pnpm** — fast npm-compatible package manager for the SPA. `pnpm install`, `pnpm --filter @aktenraum/web build`.
- **workspace (uv / pnpm)** — multiple packages sharing one lockfile + virtualenv. Our `packages/aktenraum-core` + `services/auto-tagger` + `services/aktenraum-api` are one uv workspace; the SPA is its own pnpm workspace.
- **Tauri** — the framework we'll use to ship aktenraum as a desktop app (per ADR-002). A small Rust shell that bundles a browser WebView and starts/stops the Docker stack. Not built yet; phased plan in `docs/plans/desktop-app.md`.
- **WebView** — the browser engine embedded inside a desktop app. WebKit on macOS, WebView2 on Windows. Renders our SPA inside the Tauri shell.

---

## Languages & frameworks

- **Python 3.13** — the version pinned in `.python-version`. The auto-tagger, aktenraum-api, and aktenraum-core are all Python.
- **FastAPI** — the web framework `aktenraum-api` is built on. Async Python; we use it for the REST endpoints under `/api/*`.
- **uvicorn** — the ASGI web server that runs the FastAPI app inside the `aktenraum-api` container.
- **ASGI** — Async Server Gateway Interface. The Python convention for async-aware web servers. FastAPI is ASGI-native.
- **Starlette** — the foundation FastAPI sits on. We touch it directly for middleware (`services/aktenraum-api/src/aktenraum_api/middleware.py`).
- **aiohttp** — async HTTP library. We use it inside the auto-tagger for the `/trigger/extract` webhook listener (FastAPI is overkill there).
- **SQLAlchemy 2 (async)** — the ORM for the `aktenraum` Postgres database (users, settings, type-fields). Always `async`.
- **Alembic** — schema-migration tool that goes with SQLAlchemy. Migrations live under `services/aktenraum-api/alembic/versions/`.
- **asyncpg** — fast async Postgres driver. Used by SQLAlchemy under the hood.
- **Pydantic** — Python data-validation library. Every external boundary (LLM output, request bodies, env vars) goes through a Pydantic model.
- **pydantic-settings** — the env-var loader part of Pydantic v2. Our `Settings` classes inherit `BaseSettings`.
- **httpx** — async HTTP client library. Used by `aktenraum-api` and `aktenraum-core` to talk to Paperless / Qdrant / Ollama / Anthropic.
- **structlog** — structured-log library (logs as key=value JSON instead of strings). Every log line in the project goes through it.
- **pytest / ruff** — Python test runner / linter. `task test:py` runs pytest, `task lint:py` runs ruff.
- **React 19** — the UI library for the SPA.
- **TypeScript** — typed JavaScript. The SPA is 100% TypeScript.
- **Vite** — the SPA's build tool + dev server. `task web:dev` runs it.
- **TanStack Router** — React routing library with type-safe URL params. Routes defined in `apps/web/src/router.tsx`.
- **TanStack Query** — server-state cache for React. Every `useQuery(...)` / `useMutation(...)` you see in the SPA is from here.
- **Tailwind CSS v4** — utility-first CSS framework. Every `className="px-3 py-2 …"` you see is Tailwind.
- **ESLint** — the JS/TS linter. `task lint:web` runs it.

---

## AI & retrieval

- **LLM** — Large Language Model. The auto-tagger and aktenraum-api call one to extract structured data from documents and to answer questions. We support two backends: Anthropic (cloud) and Ollama (local).
- **Anthropic** — the company; the cloud LLM provider we support (Claude models). Used when `LLM_BACKEND=anthropic`.
- **Ollama** — local LLM server (https://ollama.com). Runs models like `qwen2.5:32b` on your hardware. Used when `LLM_BACKEND=ollama`.
- **bge-m3** — the embedding model we use for RAG. Ollama-served. Multilingual; outputs 1024-dim dense vectors.
- **bge-reranker-v2-m3** — the cross-encoder reranker we use after the initial Qdrant search. Sentence-transformers-based; loaded inside `aktenraum-api`.
- **embedding** — a list of numbers (1024 for bge-m3) representing the meaning of a piece of text. Two embeddings are "close" if the underlying texts mean similar things. We compute embeddings for every doc chunk at index time and for the user's question at query time.
- **dense vector / sparse vector** — two ways to represent a chunk's meaning. Dense is the 1024-float bge-m3 output (semantic similarity). Sparse is more like a keyword index. Qdrant stores both and we query a hybrid.
- **chunk** — a paragraph-sized slice of a document's OCR'd text (~500 tokens, ~50-token overlap). The unit of indexing in Qdrant. Defined in `packages/aktenraum-core/src/aktenraum_core/rag/chunker.py`.
- **token** — a sub-word unit the LLM works in. Roughly ~4 chars or ~0.75 words per token in English/German.
- **OCR** — Optical Character Recognition. Paperless converts a scanned PDF into text using OCR. The text shows up in `doc.content` and is what we feed to the LLM.
- **RAG** — Retrieval-Augmented Generation. The pattern of *fetching* relevant chunks of your own data and feeding them to the LLM as context, so the LLM's answer is grounded in your documents instead of its training data. Our `/api/ai/answer/stream` endpoint is RAG.
- **rerank** — the second pass after the initial vector search. The reranker re-scores the top 50 candidates against the user's question more carefully than the vector search did; the top 5 go to the LLM. Slower but much more accurate.
- **retrieval** — fetching the right chunks from Qdrant for a given question. Phase 1 of the RAG pipeline (see `docs/plans/rag-phase-1.md`).
- **Qdrant** — open-source vector database. Stores the embeddings + chunk metadata. Runs as a Docker service; the SPA never talks to it directly.
- **vector store** — generic name for "thing that stores embeddings and answers similarity queries." Qdrant is our vector store.
- **prompt** — the text we send to the LLM. Has a system part ("Du bist ein Assistent …") and a user part (the doc text or the question).
- **prompt injection** — when content inside the input (a malicious PDF's OCR text) overrides our system prompt and makes the LLM emit something we didn't want (e.g. fake `confidence=0.99` to skip review). Mitigated by the per-type `auto_approve_rules` table (the user has to enable each type before any doc of that type can auto-approve, regardless of how high a confidence the LLM emits); see ADR-003 context section.
- **system prompt** — the part of the prompt that defines the LLM's role / rules. Our extraction system prompt lives in `services/auto-tagger/src/auto_tagger/tagger.py` as `SYSTEM_PROMPT`.
- **few-shot exemplars** — past documents + their extractions, prepended to the system prompt so the LLM mimics the user's vetted style. Configured via `FEW_SHOT_EXAMPLES` env var.
- **history hint** — short German line prepended to the system prompt naming the dominant past document_type for a known sender. Drives corpus-driven classification without retraining.
- **lifecycle tag** — one of `ai-pending`, `ai-approved`, `ai-rejected`, `ai-propagated`, `ai-propagation-error`, `ai-error`. Tracks where a doc is in the AI pipeline. The canonical list lives in `aktenraum_core.paperless.client.LIFECYCLE_TAGS`. **Auxiliary** flags (`ai-auto-approved`, `ai-low-confidence`, `ai-duplicate`, `ai-duplicate-dismissed`, `ai-index-error`, plus the user-facing `email-ingested` and `wichtig`) coexist with a lifecycle tag; they are NOT lifecycle states on their own. See the lifecycle-tag table in `docs/architecture.md`.
- **propagation / propagator** — the second worker that copies the AI-extracted fields onto Paperless's *native* fields (correspondent FK, document_type FK, created_date) once the user approves. Runs in the auto-tagger container.
- **extraction / extractor** — the first worker that calls the LLM to get structured fields out of OCR'd text. Also in the auto-tagger.
- **indexer** — the third worker. Once a doc is propagated, the indexer chunks it, embeds each chunk via bge-m3, and upserts into Qdrant.
- **auto-approve** — the routing decision that skips human review for high-confidence docs. Gated per-`DocumentType` by the `auto_approve_rules` table in the aktenraum Postgres database — each row holds `enabled` (boolean) and `min_confidence` (float). The user edits the rules at `/settings → Auto-Genehmigung`; the auto-tagger fetches them over HTTP with a 60-second TTL cache. Fail-closed when the rule store is unreachable on cold start.
- **custom field** — Paperless's mechanism for adding extra metadata to a doc beyond its built-in fields. Every `ai_*` field (`ai_confidence`, `ai_summary_de`, `ai_correspondent`, …) is a Paperless custom field.

---

## Web & networking

- **SPA** — Single-Page Application. Our React frontend at `apps/web/`. The browser loads `index.html` once; React handles all subsequent navigation client-side.
- **nginx** — the web server that sits at the edge. Serves the SPA's static assets, and reverse-proxies `/api/*` to aktenraum-api.
- **reverse proxy** — a web server that forwards requests to another server. nginx → aktenraum-api is a reverse proxy.
- **same-origin / cross-site / same-site** — browser security concepts. `same-origin` = exact same scheme+host+port; `same-site` = same registrable domain; `cross-site` = anything else. Matters for CSRF defence.
- **REST / REST API** — the architectural style our `/api/*` endpoints follow. Resources at URLs, HTTP verbs (GET/POST/PATCH/DELETE) for operations.
- **JSON** — JavaScript Object Notation. The wire format for every `/api/*` request/response that isn't a file upload or PDF stream.
- **multipart / multipart/form-data** — the content-type browsers use for file uploads. Our `/api/documents/upload` accepts it.
- **MIME / content-type** — the label that says "this byte stream is a PDF" (`application/pdf`) or "JSON" (`application/json`). The browser puts it in the `Content-Type` header.
- **CORS** — Cross-Origin Resource Sharing. Browser policy that decides whether JS on `attacker.com` can read responses from `our-api.com`. We don't enable CORS — the SPA and API are same-origin via nginx, so it's not needed.
- **CSRF / Cross-Site Request Forgery** — attack class where a malicious page makes the victim's logged-in browser do something on our site (e.g. delete a doc) by tricking it into sending an authenticated request. Defended in two layers: `SameSite=Lax` on the auth cookie + `Sec-Fetch-Site` middleware (see ADR-003).
- **XSS** — Cross-Site Scripting. Attacker-controlled JS running inside our SPA. Defended by React's automatic escaping + the strict Content-Security-Policy on the nginx response.
- **SSE / Server-Sent Events** — one-way streaming protocol where the server pushes events to the browser over a long-lived HTTP connection. Our `/api/ai/answer/stream` uses SSE: `event: meta` → repeated `event: chunk` → `event: final` (or `event: error`). The SPA reads it with `fetch` + a `ReadableStream`. Not to be confused with **SIGTERM** (a process signal) — they sound similar but are unrelated.
- **stream / streaming response** — any HTTP response delivered in pieces over time instead of all at once. SSE is one form; PDF preview/download is another (we stream the file bytes through aktenraum-api so the Paperless token stays server-side).
- **WebSocket** — bi-directional streaming protocol. We don't use it (SSE is enough for our case).
- **HTTP method / verb** — `GET` (read), `POST` (create / arbitrary action), `PATCH` (partial update), `PUT` (replace), `DELETE` (remove). State-changing methods are everything except GET.
- **status code** — the HTTP response number. `200 OK`, `201 Created`, `204 No Content`, `400 Bad Request`, `401 Unauthorized`, `403 Forbidden`, `404 Not Found`, `409 Conflict`, `413 Payload Too Large`, `429 Too Many Requests`, `500 Internal Server Error`, `502 Bad Gateway`, `503 Service Unavailable`.
- **header** — a key-value pair attached to an HTTP request or response (`Content-Type`, `Authorization`, `Cookie`, `Sec-Fetch-Site`, …).
- **cookie** — small key-value pair the browser stores per-origin and sends with every request to that origin. Our auth cookie is `aktenraum_session`.
- **httpOnly cookie** — cookie that JS can't read (only the server sees it). Our auth cookie is httpOnly so a future XSS bug can't steal it.
- **CSP / Content-Security-Policy** — response header that tells the browser "only load scripts from these origins, don't allow inline scripts, don't allow iframes." Configured in nginx.

---

## Auth, security, and concurrency

- **JWT** — JSON Web Token. A signed token containing the user id + expiry, stored in the auth cookie. We use HS256 (symmetric signing with `JWT_SECRET`).
- **HS256** — the JWT signing algorithm we use. Symmetric: same secret signs and verifies.
- **bcrypt** — the password-hashing function we use for stored user passwords. Slow on purpose so a stolen DB can't be brute-forced.
- **bootstrap user** — the first user, seeded from `BOOTSTRAP_USERNAME` + `BOOTSTRAP_PASSWORD` env vars on container startup if the users table is empty. Ignored once any user exists.
- **`SameSite=Lax` cookie** — cookie attribute that tells the browser "don't send this cookie on cross-site subrequests." Blocks the most obvious CSRF vectors.
- **`Secure` cookie** — cookie attribute that tells the browser "only send this cookie over HTTPS." Our `COOKIE_SECURE` defaults to `True`; localhost dev opts out.
- **`Sec-Fetch-Site`** — request header all modern browsers add. Tells the server whether the request comes from the same origin, a same-site sibling, or a cross-site page. Our CSRF middleware reads it.
- **timing attack** — when an attacker measures how long a string-comparison takes to deduce the right value byte-by-byte. Defended with `hmac.compare_digest` (constant-time comparison).
- **TOCTOU / Time-of-Check Time-of-Use** — race-condition class where the state checked at time T1 changed before the action at T2. Our `swap_lifecycle_tag` had one: read tags, plan, PATCH — a parallel writer in between would lose. Fixed by re-reading after PATCH and retrying on mismatch.
- **race condition** — generic term for "two concurrent operations interleave in a way that produces a wrong result." TOCTOU is one kind.
- **idempotent** — an operation you can run multiple times with the same effect as running it once. Paperless dedupes uploads by SHA1, so re-uploading the same file is idempotent. `swap_lifecycle_tag` is idempotent: re-approving an already-approved doc is a no-op.
- **rate limit** — capping how many requests per second a client can make. We don't implement it explicitly; the upload caps + bulk-approve concurrency limiter approximate it for the most expensive paths.
- **secret / token** — any private string that authenticates a caller. We have several: `JWT_SECRET`, `WEBHOOK_SECRET`, `PAPERLESS_API_TOKEN`, `RESTIC_PASSWORD`, `ANTHROPIC_API_KEY`. None committed to git per ADR-002.
- **defence in depth** — adding multiple independent layers of defence so any single bug doesn't lead to a breach. `SameSite=Lax` + `Sec-Fetch-Site` middleware + httpOnly cookie + CSP is defence in depth against CSRF/XSS.

---

## Concurrency, async, OS signals

- **async / await** — Python keywords for cooperative multitasking. An `async def` function returns a coroutine; `await` pauses until the awaited operation completes.
- **asyncio** — Python's built-in async event-loop library. Everything in aktenraum-api and the auto-tagger is asyncio.
- **coroutine** — the return value of an `async def`. Has to be `await`ed (or scheduled via `asyncio.create_task`) to actually run.
- **task** — a coroutine wrapped in `asyncio.create_task(...)` so it runs in the background. The auto-tagger gathers up to six tasks (extraction worker + poller, propagation worker + poller, indexer, HTTP server) in one `asyncio.gather`.
- **event loop** — the asyncio scheduler. Picks the next ready coroutine, runs it until it awaits, switches.
- **gather** — `asyncio.gather(t1, t2, t3)` runs multiple tasks concurrently and waits for all to finish. If any raises, the others get cancelled.
- **shield** — `asyncio.shield(...)` wraps a coroutine so that a cancellation of the *outer* task doesn't cancel the wrapped operation. We use it on the propagator's lifecycle-flipping PATCH so SIGTERM can't tear it apart mid-swap.
- **queue / asyncio.Queue** — thread/coroutine-safe FIFO. The auto-tagger has one for extraction work (`put_nowait` from the webhook + the poller, `get` from the worker) and one for indexing.
- **lock** — `asyncio.Lock()` is a mutex. Only one coroutine can hold it at a time. We use one in the reranker to prevent two simultaneous "first /ask" calls from each downloading the 600 MB model.
- **signal / SIGTERM / SIGINT** — operating-system messages sent to a process. `SIGTERM` = "please shut down cleanly." `SIGINT` = Ctrl-C. Docker sends SIGTERM to containers on `docker compose down` / restart. Our auto-tagger installs handlers for both via `loop.add_signal_handler`. *Not* SSE — SIGTERM is a process signal, SSE is an HTTP streaming protocol; they're unrelated despite both being three-letter acronyms.
- **graceful shutdown** — finishing in-flight work before exiting, instead of getting yanked mid-operation. Our auto-tagger's gather watches a shutdown Event so each loop finishes its current iteration on SIGTERM.

---

## Data, storage, search

- **Postgres / PostgreSQL** — the SQL database. Hosts two databases in one process: `paperless` (Paperless owns it) and `aktenraum` (we own it).
- **schema** — the structure of a database: tables, columns, types, constraints. Alembic migrates ours.
- **migration** — a versioned SQL script that moves the schema forward. Lives under `services/aktenraum-api/alembic/versions/`.
- **FK / Foreign Key** — a column that points at the primary key of another table. `doc.correspondent` is an FK into `correspondents.id` in Paperless.
- **N+1 query / N+1 round trip** — anti-pattern where a loop does one query per iteration when one batched query would do. The pre-fix auto-tagger hit Paperless N+3 times per document — see this session's perf fix.
- **TTL / Time-To-Live** — how long a cache entry is valid before it has to be re-fetched. Our `PaperlessClient` and `PaperlessGateway` caches default to 300 seconds (5 minutes).
- **cache invalidation** — clearing a cache entry so the next read fetches fresh. Hard to get right; the joke "there are two hard problems in computer science: cache invalidation and naming things" is half about this.
- **idempotent backfill** — a script that walks the corpus and fills in missing fields, safe to re-run because already-correct rows are no-ops. `scripts/backfill-rag-index.sh` is one.
- **restic** — the backup tool we use. Encrypts + deduplicates + snapshots. The `backup` container runs it on a cron.
- **snapshot (restic)** — one point-in-time backup. `restic snapshots` lists them; the retention policy is 7 daily / 4 weekly / 12 monthly.
- **WAL / wal_level** — Postgres internal: how it logs changes for durability + replication. Not currently tuned; default is fine for our scale.

---

## Code organisation & tooling

- **monorepo** — one git repo holding multiple packages. We have a Python monorepo (uv workspace: `packages/aktenraum-core`, `services/auto-tagger`, `services/aktenraum-api`) and a separate pnpm monorepo for the SPA (`apps/web`).
- **package vs service** — in our layout: a *package* is library code shared between services (`packages/aktenraum-core`); a *service* is a deployable that runs in its own container (`services/auto-tagger`, `services/aktenraum-api`).
- **factory function** — a function that constructs an object based on config. `aktenraum_core.llm.build_active_backend(settings)` is a factory: it returns either an `OllamaBackend` or `AnthropicBackend` depending on env.
- **gateway / facade** — a class that wraps a remote API behind a tidy interface and holds the credentials. `PaperlessGateway` is our gateway to Paperless.
- **BFF / Backend-For-Frontend** — pattern where a server-side API exists specifically to serve one client. `aktenraum-api` is the BFF for our SPA: it holds the Paperless token, exposes only the calls the SPA needs, and adds AI features Paperless lacks. The SPA never talks to Paperless directly.
- **router (FastAPI)** — a group of endpoints sharing a prefix. We have one per area: `auth`, `inbox`, `library`, `documents`, `ai`, `type_fields`, `settings`, `health`.
- **middleware** — code that runs on every request/response, between the HTTP layer and the route handler. Our `CSRFMiddleware` and `SecurityHeadersMiddleware` are FastAPI/Starlette middlewares.
- **dependency injection (FastAPI `Depends`)** — declaring a parameter on a route handler that FastAPI fills in by calling the named function. `gateway: PaperlessGateway = Depends(get_paperless_gateway)` is dependency injection.
- **lifespan** — FastAPI hook that runs setup once at startup and cleanup once at shutdown. We use it to build the Postgres engine, the gateway, and pre-warm the reranker.
- **app.state** — FastAPI's per-app key-value store. We stash long-lived objects there (engine, session factory, gateway, retrieval deps).
- **noqa** — comment that tells the linter "ignore this rule on this line." We have `# noqa: SLF001` in several places where a route reaches into a gateway's underscored helper. Flagged for cleanup.
- **type hint** — Python annotation like `def f(x: int) -> str:`. Doesn't affect runtime; consumed by mypy / Pydantic / IDEs.

---

## Frontend specifics

- **route** — a URL pattern + the component that renders it. `apps/web/src/router.tsx` lists them all (`/library`, `/inbox/$id`, `/ask`, …).
- **lazy route / code splitting** — loading a route's JS bundle only when the user navigates there, not on initial page load. Saves bandwidth + first-paint time. We do it with `React.lazy(() => import(...))` per route.
- **Suspense** — React component that renders a fallback while a lazy-loaded child is still downloading. Our `RouteSuspense` wraps every lazy route with a "Lade…" fallback.
- **hook** — a React function starting with `use…` that hooks into render state. `useState`, `useEffect`, `useMutation` (TanStack Query).
- **mutation / query (TanStack Query)** — `useQuery` = read; `useMutation` = write. Both manage loading/error state and cache invalidation.
- **query key** — array that uniquely identifies a cached query result. `["library", "list", filters, page]`.
- **invalidate** — mark a cached query stale so the next render refetches. `qc.invalidateQueries({queryKey: ["library"]})`.
- **stale time / refetch interval** — how long a query is considered fresh / how often to auto-refetch in the background. Tuned per query.
- **AbortController** — browser API for cancelling an in-flight `fetch`. Used in our SSE consumer so navigating away mid-stream stops billing tokens.
- **TanStack Router search params** — URL query string typed via a `validateSearch` function. Our `/library?tab=review&date_from=…` is fully type-safe end-to-end.

---

## Workflow & process

- **commit** — one atomic git change. Has a hash, message, author. Format: `feat(area): summary` or `fix(area): summary`.
- **branch** — a named line of git history. `main` is the trunk.
- **PR / Pull Request** — proposing a branch be merged into `main`, with review + CI.
- **CI / Continuous Integration** — automation that runs tests + lint on every push. Our CI is `.github/workflows/ci.yml` (uv + pytest + ruff + pnpm build).
- **hot reload / HMR** — when the dev server reapplies your code change without a full page refresh. Vite gives us HMR for the SPA via `task web:dev`. The Python services don't have HMR yet (see next-session pick-up in the previous session note).
- **backfill** — a one-time script that fills in data that the live pipeline didn't produce yet. `scripts/backfill-rag-index.sh` indexes the existing corpus into Qdrant.
- **eval harness** — script that scores the system against a curated set of expected answers. `evals/golden-questions.yaml` is the input; `python -m aktenraum_api.eval.runner` runs it and reports recall@K and MRR.
- **recall@K** — fraction of questions where the expected doc id is in the top K retrieved. Higher is better.
- **MRR / Mean Reciprocal Rank** — averages `1/rank` across questions. Penalises the expected doc being lower in the list. Higher is better.

---

## Domain-specific German terms (the 27 document types)

These are the document_type values the AI extracts and routes on. Most are self-explanatory; the disambiguation rules live in `services/auto-tagger/src/auto_tagger/tagger.py` SYSTEM_PROMPT and `docs/document-types.md`.

- **Rechnung** — invoice / bill (asks for payment).
- **Beleg** — payment proof: Quittung, Kassenbon, Zahlungsbestätigung. Distinct from Rechnung (which asks for payment) and from Kontoauszug (which lists many transactions).
- **Gehaltsabrechnung** — monthly payslip.
- **Kontoauszug** — bank/credit-card statement.
- **Nebenkostenabrechnung** — annual heat/water/utilities statement issued by a landlord (tenant-side).
- **Hausgeldabrechnung** — annual WEG (homeowners' association) statement (owner-side). Frequently confused with Nebenkostenabrechnung.
- **Mahnung** — payment reminder / dunning notice.
- **Vertrag** — contract (any kind — work, rental, sale, …).
- **Kündigung** — termination notice (of a contract / subscription / membership).
- **Versicherung** — insurance policy or related document.
- **Steuer** — tax filing or tax-related document (NOT the annual employer Lohnsteuerbescheinigung — that's its own type).
- **Lohnsteuerbescheinigung** — annual payroll tax certificate from your employer (§41b EStG).
- **Spendenbescheinigung** — donation receipt (Zuwendungsbestätigung §50 EStDV).
- **Bescheid** — official ruling from an authority (Steuerbescheid, Rentenbescheid, BAföG-Bescheid, …) — NOT a traffic fine.
- **Behördenbrief** — letter from an authority without ruling character (info, address confirmation, …).
- **Sozialversicherungsmeldung** — employer's annual DEÜV social-insurance report.
- **Kfz** — vehicle paperwork (registration, TÜV, …).
- **Bußgeldbescheid** — traffic fine / penalty notice.
- **Arztbrief** — medical letter / report / findings.
- **Krankschreibung** — short sick note ("gelber Schein", AU-Bescheinigung).
- **Garantie** — warranty certificate.
- **Urkunde** — civil-registry document (birth/marriage/death certificate, notarial deed).
- **Ausweis** — ID document (passport, ID card, driver's license, health-insurance card).
- **Zeugnis** — school / academic / professional certificate.
- **Arbeitszeugnis** — employer reference letter.
- **Mitgliedschaft** — membership document (gym, club, union, broadcasting fee, streaming subscription).
- **Sonstiges** — catch-all when no other type fits.
