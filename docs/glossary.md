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

- **Docker Compose** — the tool that runs all 10 services (Paperless, Postgres, Redis, Qdrant, auto-tagger, aktenraum-api, nginx, gotenberg, tika, backup) from one `docker/docker-compose.yml` file. `task start` starts them.
- **container** — an isolated process running one service. Each row of `docker compose ps` is a container.
- **service** — a logical role in `docker-compose.yml` (e.g. `paperless`, `qdrant`). Maps 1:1 to a container in our setup.
- **healthcheck** — a probe Docker runs against a container to mark it `(healthy)`. Used by `depends_on: service_healthy` to delay startup of dependent services.
- **bind mount / volume** — a host directory mapped into a container so data survives container restarts. Our bind mounts live under `${AKTENRAUM_DATA_DIR:-${HOME}/aktenraum}/`.
- **env file** — a `KEY=VALUE` text file Docker Compose loads into a service's environment. There is exactly one: `docker/.env`, loaded by every service (template: `docker/.env.example`). Per `ADR-002` it is not committed; `scripts/bootstrap-secrets.sh` creates and fills it on first run.
- **Taskfile** — `Taskfile.yml` at repo root (https://taskfile.dev). Wraps every common workflow as a one-liner — `task start`, `task build`, `task lint`, etc. `task --list` enumerates them.
- **pnpm** — fast npm-compatible package manager. `pnpm install` installs every package, `pnpm -r test` tests them all, `pnpm --filter @aktenraum/web build` targets one.
- **workspace (pnpm)** — multiple packages sharing one lockfile and one `node_modules` store. `packages/aktenraum-core`, `services/auto-tagger`, `services/aktenraum-api` and `apps/web` are one pnpm workspace (`pnpm-workspace.yaml`, `pnpm-lock.yaml`); packages depend on each other with `workspace:*`.
- **Tauri** — the framework we'll use to ship aktenraum as a desktop app (per ADR-002). A small Rust shell that bundles a browser WebView and starts/stops the Docker stack. Not built yet; phased plan in `docs/plans/desktop-app.md`.
- **WebView** — the browser engine embedded inside a desktop app. WebKit on macOS, WebView2 on Windows. Renders our SPA inside the Tauri shell.

---

## Languages & frameworks

- **Node.js 22** — the JavaScript runtime every service runs on (pinned in `.nvmrc`; Docker images are `node:22-slim`).
- **TypeScript** — typed JavaScript. All application code (api, worker, shared library, SPA) is TypeScript.
- **ESM** — ECMAScript Modules (`import`/`export`), the module format every package uses. `@aktenraum/core` is ESM-only, which is why the NestJS API also runs as ESM.
- **NestJS** — the server framework `aktenraum-api` is built on (on top of Express via `@nestjs/platform-express`). Organises code into modules, controllers (routes) and injectable services.
- **Express** — the HTTP server library underneath NestJS. Our CSRF and security-header middleware (`services/aktenraum-api/src/common/middleware.ts`) are plain Express middleware functions.
- **`node:http`** — Node's built-in HTTP server. The auto-tagger uses it directly for its small `/trigger/*` webhook listener (`services/auto-tagger/src/webhook.ts`); a framework would be overkill there.
- **zod** — TypeScript schema-validation library. Every external boundary (LLM output, request bodies, env vars) is parsed with a zod schema; `zod-to-json-schema` turns the extraction schema into the JSON schema sent to the LLM.
- **drizzle-orm** — the TypeScript ORM / query builder for the `aktenraum` Postgres database (users, settings, auto-approve rules, type fields). Table models in `services/aktenraum-api/src/db/schema.ts`.
- **pg (node-postgres)** — the Postgres driver drizzle runs on (`drizzle-orm/node-postgres` over a `pg.Pool`).
- **pg-mem** — an in-memory Postgres emulator. The API test suite runs the real Nest app against it instead of a real database.
- **fetch** — the HTTP client built into Node 22. Used by `@aktenraum/core` and the API to talk to Paperless and Ollama; Qdrant goes through `@qdrant/js-client-rest`, Anthropic through `@anthropic-ai/sdk`.
- **structured logging** — logs written as one JSON object per line (`{"level":"info","event":"doc_extracted",...}`) instead of free text. Every service logs through `logger` in `packages/aktenraum-core/src/log.ts`.
- **tsx** — runs TypeScript directly without a build step. `tsx watch` powers the dev overlay's hot reload of both Node services.
- **vitest** — the test runner for all four packages. `task test` runs it everywhere.
- **supertest** — HTTP assertion library the API tests use to drive the Nest app.
- **ESLint** — the JS/TS linter. `task lint` runs it across all four packages.
- **Vue 3** — the UI library for the SPA. Components are single-file `.vue` files using `<script setup lang="ts">` and the Composition API (`ref`, `computed`, `watch`).
- **Nuxt 4** — the framework around Vue: file-based routing, layouts, route middleware, plugins and auto-imports. We run it with `ssr: false` (pure client-side SPA) and `nuxt generate` writes static files that nginx serves. Config in `apps/web/nuxt.config.ts`. See ADR-008.
- **Vite** — the build tool + dev server Nuxt uses under the hood. `task web:dev` runs `nuxt dev` on `:4300`.
- **TanStack Vue Query (`@tanstack/vue-query`)** — server-state cache for Vue. Every `useQuery(...)` / `useMutation(...)` you see in the SPA is from here. The `QueryClient` is created in `apps/web/app/plugins/vue-query.client.ts`.
- **Tailwind CSS v4** — utility-first CSS framework. Every `class="px-3 py-2 …"` you see is Tailwind.
- **`@nuxt/test-utils`** — Nuxt's testing helpers. SPA tests mount components with `mountSuspended` inside a Nuxt test environment.

---

## AI & retrieval

- **LLM** — Large Language Model. The auto-tagger and aktenraum-api call one to extract structured data from documents and to answer questions. We support two backends: Anthropic (cloud) and Ollama (local).
- **Anthropic** — the company; the cloud LLM provider we support (Claude models). Used when `LLM_BACKEND=anthropic`.
- **Ollama** — local LLM server (https://ollama.com). Runs models like `qwen2.5:14b-instruct-q8_0` on your hardware. Used when `LLM_BACKEND=ollama`.
- **Qwen3-Embedding-4B (`qwen3-embedding:4b`)** — the embedding model we use for RAG. Ollama-served, set via `EMBEDDING_MODEL`. Multilingual; outputs 2560-dim dense vectors (`DENSE_DIM` in `packages/aktenraum-core/src/rag/embedder.ts`).
- **bge-reranker-v2-m3** — the cross-encoder reranker we use after the initial Qdrant search. Its ONNX export runs in-process inside `aktenraum-api` via transformers.js.
- **transformers.js (`@huggingface/transformers`)** — runs Hugging Face models (here the reranker, as ONNX) inside Node. Model files are cached in the `aktenraum-node-hf-cache` Docker volume.
- **embedding** — a list of numbers (2560 for qwen3-embedding:4b) representing the meaning of a piece of text. Two embeddings are "close" if the underlying texts mean similar things. We compute embeddings for every doc chunk at index time and for the user's question at query time.
- **dense vector / sparse vector** — two ways to represent a chunk's meaning. Dense is the 2560-float embedding output (semantic similarity). Sparse is more like a keyword index. We currently store and query dense vectors only; sparse/hybrid retrieval is planned, not implemented.
- **chunk** — a paragraph-sized slice of a document's OCR'd text (~500 tokens, ~50-token overlap). The unit of indexing in Qdrant. Defined in `packages/aktenraum-core/src/rag/chunker.ts`.
- **token** — a sub-word unit the LLM works in. Roughly ~4 chars or ~0.75 words per token in English/German.
- **OCR** — Optical Character Recognition. Paperless converts a scanned PDF into text using OCR. The text shows up in `doc.content` and is what we feed to the LLM.
- **RAG** — Retrieval-Augmented Generation. The pattern of *fetching* relevant chunks of your own data and feeding them to the LLM as context, so the LLM's answer is grounded in your documents instead of its training data. Our `/api/ai/answer/stream` endpoint is RAG.
- **rerank** — the second pass after the initial vector search. The reranker re-scores the top 50 candidates against the user's question more carefully than the vector search did; the top 5 go to the LLM. Slower but much more accurate.
- **retrieval** — fetching the right chunks from Qdrant for a given question. Phase 1 of the RAG pipeline (see `docs/plans/rag-phase-1.md`).
- **Qdrant** — open-source vector database. Stores the embeddings + chunk metadata. Runs as a Docker service; the SPA never talks to it directly.
- **vector store** — generic name for "thing that stores embeddings and answers similarity queries." Qdrant is our vector store.
- **prompt** — the text we send to the LLM. Has a system part ("Du bist ein Assistent …") and a user part (the doc text or the question).
- **prompt injection** — when content inside the input (a malicious PDF's OCR text) overrides our system prompt and makes the LLM emit something we didn't want (e.g. fake `confidence=0.99` to skip review). Mitigated by the per-type `auto_approve_rules` table (the user has to enable each type before any doc of that type can auto-approve, regardless of how high a confidence the LLM emits); see ADR-003 context section.
- **system prompt** — the part of the prompt that defines the LLM's role / rules. Our extraction system prompt lives in `services/auto-tagger/src/prompt.ts` as `SYSTEM_PROMPT`.
- **few-shot exemplars** — past documents + their extractions, prepended to the system prompt so the LLM mimics the user's vetted style. Configured via `FEW_SHOT_EXAMPLES` env var.
- **history hint** — short German line prepended to the system prompt naming the dominant past document_type for a known sender. Drives corpus-driven classification without retraining.
- **lifecycle tag** — one of `ai-pending`, `ai-approved`, `ai-rejected`, `ai-propagated`, `ai-propagation-error`, `ai-error`. Tracks where a doc is in the AI pipeline. The canonical list lives in `LIFECYCLE_TAGS` in `packages/aktenraum-core/src/paperless/client.ts`. **Auxiliary** flags (`ai-auto-approved`, `ai-low-confidence`, `ai-duplicate`, `ai-duplicate-dismissed`, `ai-index-error`, plus the user-facing `email-ingested` and `wichtig`) coexist with a lifecycle tag; they are NOT lifecycle states on their own. See the lifecycle-tag table in `docs/architecture.md`.
- **propagation / propagator** — the second worker that copies the AI-extracted fields onto Paperless's *native* fields (correspondent FK, document_type FK, created_date) once the user approves. Runs in the auto-tagger container.
- **extraction / extractor** — the first worker that calls the LLM to get structured fields out of OCR'd text. Also in the auto-tagger.
- **indexer** — the third worker. Once a doc is propagated, the indexer chunks it, embeds each chunk via the embedding model, and upserts into Qdrant.
- **auto-approve** — the routing decision that skips human review for high-confidence docs. Gated per-`DocumentType` by the `auto_approve_rules` table in the aktenraum Postgres database — each row holds `enabled` (boolean) and `min_confidence` (float). The user edits the rules at `/settings → Auto-Genehmigung`; the auto-tagger fetches them over HTTP with a 60-second TTL cache. Fail-closed when the rule store is unreachable on cold start.
- **custom field** — Paperless's mechanism for adding extra metadata to a doc beyond its built-in fields. Every `ai_*` field (`ai_confidence`, `ai_summary_de`, `ai_correspondent`, …) is a Paperless custom field.

---

## Web & networking

- **SPA** — Single-Page Application. Our Nuxt/Vue frontend at `apps/web/`. The browser loads `index.html` once; Vue Router (inside Nuxt) handles all subsequent navigation client-side.
- **nginx** — the web server that sits at the edge. Serves the SPA's static assets, and reverse-proxies `/api/*` to aktenraum-api.
- **reverse proxy** — a web server that forwards requests to another server. nginx → aktenraum-api is a reverse proxy.
- **same-origin / cross-site / same-site** — browser security concepts. `same-origin` = exact same scheme+host+port; `same-site` = same registrable domain; `cross-site` = anything else. Matters for CSRF defence.
- **REST / REST API** — the architectural style our `/api/*` endpoints follow. Resources at URLs, HTTP verbs (GET/POST/PATCH/DELETE) for operations.
- **JSON** — JavaScript Object Notation. The wire format for every `/api/*` request/response that isn't a file upload or PDF stream.
- **multipart / multipart/form-data** — the content-type browsers use for file uploads. Our `/api/documents/upload` accepts it.
- **MIME / content-type** — the label that says "this byte stream is a PDF" (`application/pdf`) or "JSON" (`application/json`). The browser puts it in the `Content-Type` header.
- **CORS** — Cross-Origin Resource Sharing. Browser policy that decides whether JS on `attacker.com` can read responses from `our-api.com`. We don't enable CORS — the SPA and API are same-origin via nginx, so it's not needed.
- **CSRF / Cross-Site Request Forgery** — attack class where a malicious page makes the victim's logged-in browser do something on our site (e.g. delete a doc) by tricking it into sending an authenticated request. Defended in two layers: `SameSite=Lax` on the auth cookie + `Sec-Fetch-Site` middleware (see ADR-003).
- **XSS** — Cross-Site Scripting. Attacker-controlled JS running inside our SPA. Defended by Vue's automatic template escaping + the strict Content-Security-Policy on the nginx response.
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
- **timing attack** — when an attacker measures how long a string-comparison takes to deduce the right value byte-by-byte. Defended with Node's `crypto.timingSafeEqual` (constant-time comparison) on the webhook secret.
- **TOCTOU / Time-of-Check Time-of-Use** — race-condition class where the state checked at time T1 changed before the action at T2. Our `swapLifecycleTag` had one: read tags, plan, PATCH — a parallel writer in between would lose. Fixed by re-reading after PATCH and retrying on mismatch.
- **race condition** — generic term for "two concurrent operations interleave in a way that produces a wrong result." TOCTOU is one kind.
- **idempotent** — an operation you can run multiple times with the same effect as running it once. Paperless dedupes uploads by SHA1, so re-uploading the same file is idempotent. `swapLifecycleTag` is idempotent: re-approving an already-approved doc is a no-op.
- **rate limit** — capping how many requests per second a client can make. We don't implement it explicitly; the upload caps + bulk-approve concurrency limiter approximate it for the most expensive paths.
- **secret / token** — any private string that authenticates a caller. We have several: `JWT_SECRET`, `WEBHOOK_SECRET`, `PAPERLESS_API_TOKEN`, `RESTIC_PASSWORD`, `ANTHROPIC_API_KEY`. None committed to git per ADR-002.
- **defence in depth** — adding multiple independent layers of defence so any single bug doesn't lead to a breach. `SameSite=Lax` + `Sec-Fetch-Site` middleware + httpOnly cookie + CSP is defence in depth against CSRF/XSS.

---

## Concurrency, async, OS signals

- **async / await** — JavaScript keywords for working with Promises. An `async function` returns a Promise; `await` pauses that function until the awaited operation settles, while the rest of the process keeps running.
- **Promise** — an object representing a value that will be available later (or an error). Every I/O call in the services returns one.
- **event loop** — Node's single-threaded scheduler. Runs JS until it hits an `await` on pending I/O, then switches to whatever else is ready.
- **concurrent loops** — the auto-tagger runs five long-lived async loops (extraction consumer, poller, propagation, indexer, plus the webhook HTTP server) started in `services/auto-tagger/src/main.ts` and awaited together with `Promise.all`.
- **queue / `AsyncQueue`** — the worker's in-memory FIFO (`services/auto-tagger/src/queue.ts`). The webhook and the poller push document ids; a consumer loop awaits the next one. There is one each for extraction, propagation and indexing. Contents are lost on restart; the poller and the start-up index reconcile re-fill them.
- **in-flight promise** — reusing one pending Promise so concurrent callers wait on the same work instead of repeating it. The reranker keeps its model-load Promise so two simultaneous "first /ask" requests do not each load the model.
- **AbortController / AbortSignal** — the standard cancellation primitive. The worker creates one `AbortController`; on shutdown it aborts the signal, every loop checks `signal.aborted` and stops after its current item.
- **signal / SIGTERM / SIGINT** — operating-system messages sent to a process. `SIGTERM` = "please shut down cleanly." `SIGINT` = Ctrl-C. Docker sends SIGTERM to containers on `docker compose down` / restart. The auto-tagger handles both with `process.on(...)`. *Not* SSE — SIGTERM is a process signal, SSE is an HTTP streaming protocol; they're unrelated despite both being three-letter acronyms.
- **graceful shutdown** — finishing in-flight work before exiting, instead of getting yanked mid-operation. On SIGTERM the worker aborts its signal, closes its queues and the webhook server, and each loop finishes its current document.

---

## Data, storage, search

- **Postgres / PostgreSQL** — the SQL database. Hosts two databases in one process: `paperless` (Paperless owns it) and `aktenraum` (we own it).
- **schema** — the structure of a database: tables, columns, types, constraints. Ours is defined in `services/aktenraum-api/src/db/schema.sql` and applied at API startup.
- **schema apply** — instead of versioned migrations, `applySchema()` runs the idempotent `CREATE TABLE IF NOT EXISTS` statements in `services/aktenraum-api/src/db/schema.sql` in one transaction before the Nest app boots. `schema.ts` (the drizzle model) must match it; a test fails if they drift.
- **FK / Foreign Key** — a column that points at the primary key of another table. `doc.correspondent` is an FK into `correspondents.id` in Paperless.
- **N+1 query / N+1 round trip** — anti-pattern where a loop does one query per iteration when one batched query would do. Avoided in the Paperless client by caching entity lookups (tags, custom fields, correspondents).
- **TTL / Time-To-Live** — how long a cache entry is valid before it has to be re-fetched. Our `PaperlessClient` and `PaperlessGateway` caches default to 300 seconds (5 minutes).
- **cache invalidation** — clearing a cache entry so the next read fetches fresh. Hard to get right; the joke "there are two hard problems in computer science: cache invalidation and naming things" is half about this.
- **idempotent backfill** — a script that walks the corpus and fills in missing fields, safe to re-run because already-correct rows are no-ops. `scripts/backfill-rag-index.sh` is one.
- **restic** — the backup tool we use. Encrypts + deduplicates + snapshots. The `backup` container runs it on a cron.
- **snapshot (restic)** — one point-in-time backup. `restic snapshots` lists them; the retention policy is 7 daily / 4 weekly / 12 monthly.
- **WAL / wal_level** — Postgres internal: how it logs changes for durability + replication. Not currently tuned; default is fine for our scale.

---

## Code organisation & tooling

- **monorepo** — one git repo holding multiple packages. Ours is a single pnpm workspace: `packages/aktenraum-core`, `services/auto-tagger`, `services/aktenraum-api`, `apps/web`.
- **package vs service** — in our layout: a *package* is library code shared between services (`packages/aktenraum-core`); a *service* is a deployable that runs in its own container (`services/auto-tagger`, `services/aktenraum-api`).
- **factory function** — a function that constructs an object based on config. `createBackend(name, options)` in `packages/aktenraum-core/src/llm/factory.ts` is a factory: it returns either an `OllamaBackend` or `AnthropicBackend` depending on env.
- **gateway / facade** — a class that wraps a remote API behind a tidy interface and holds the credentials. `PaperlessGateway` is our gateway to Paperless.
- **BFF / Backend-For-Frontend** — pattern where a server-side API exists specifically to serve one client. `aktenraum-api` is the BFF for our SPA: it holds the Paperless token, exposes only the calls the SPA needs, and adds AI features Paperless lacks. The SPA never talks to Paperless directly.
- **module (NestJS)** — a unit that groups related controllers and providers. One per area: `auth`, `inbox`, `library`, `documents`, `upload`, `ai`, `type-fields`, `settings`, `trash`, `events`, `health`, wired together in `services/aktenraum-api/src/app.module.ts`.
- **controller (NestJS)** — a class whose decorated methods are HTTP routes (`@Controller("inbox")` + `@Get(":id")` → `GET /api/inbox/:id`). The global `/api` prefix is set in `main.ts`.
- **middleware** — code that runs on every request/response, between the HTTP layer and the route handler. Our `csrfMiddleware` and `securityHeadersMiddleware` are Express middleware registered in `main.ts`.
- **dependency injection (NestJS)** — Nest builds services and hands them to constructors that declare them (`constructor(private readonly gateway: PaperlessGateway)`), so classes never construct their own dependencies.
- **guard (NestJS)** — a class that decides whether a request may reach a route. `AuthGuard` checks the session cookie.
- **pipe / filter (NestJS)** — a pipe transforms or validates input before the handler runs (our `ZodValidationPipe`); an exception filter shapes errors on the way out (ours always returns `{detail}`).
- **ESLint disable comment** — `// eslint-disable-next-line <rule>` tells the linter to skip one rule on one line. `prompt.ts` disables `max-len` for the whole file on purpose.
- **type annotation** — TypeScript syntax like `function f(x: number): string`. Checked at compile time by `tsc`; erased at runtime, so runtime validation still needs zod.

---

## Frontend specifics

- **route / page** — a URL pattern + the component that renders it. Nuxt derives routes from the files under `apps/web/app/pages/` (`library/index.vue` → `/library`, `inbox/[id].vue` → `/inbox/:id`, `[...slug].vue` → catch-all 404).
- **lazy route / code splitting** — loading a route's JS bundle only when the user navigates there, not on initial page load. Saves bandwidth + first-paint time. Nuxt splits every page into its own chunk automatically.
- **composable** — a Vue function starting with `use…` that bundles reactive state and logic for reuse. Ours live in `apps/web/app/composables/` (`useApi`, `useLibrary`, `useInbox`, `useAnswerStream`, …) and are auto-imported by Nuxt.
- **route middleware** — a Nuxt function that runs before navigating to a page. Our named `auth` and `guest` middleware (`apps/web/app/middleware/`) redirect to `/login` or away from it; pages opt in with `definePageMeta({ middleware: 'auth' })`.
- **plugin (Nuxt)** — code that runs once when the app starts. A `.client.ts` suffix means browser-only. `vue-query.client.ts` installs the query client; `live-counts.client.ts` opens the live-counts SSE stream once a user is signed in.
- **layout** — a wrapper component around pages. `default.vue` renders the nav; `bare.vue` (login, health) does not.
- **mutation / query (TanStack Query)** — `useQuery` = read; `useMutation` = write. Both manage loading/error state and cache invalidation.
- **query key** — array that uniquely identifies a cached query result. `["library", "list", filters, page]`.
- **invalidate** — mark a cached query stale so the next render refetches. `qc.invalidateQueries({queryKey: ["library"]})`.
- **stale time / refetch interval** — how long a query is considered fresh / how often to auto-refetch in the background. Tuned per query.
- **AbortController** — browser API for cancelling an in-flight `fetch`. Used in our SSE consumer so navigating away mid-stream stops billing tokens.
- **search params / route query** — the URL query string, read with `useRoute().query`. Library filters live there (`/library?tab=review&date_from=…`) so views are bookmarkable and the back button works; the reactive query key follows it.

---

## Workflow & process

- **commit** — one atomic git change. Has a hash, message, author. Format: `feat(area): summary` or `fix(area): summary`.
- **branch** — a named line of git history. `main` is the trunk.
- **PR / Pull Request** — proposing a branch be merged into `main`, with review + CI.
- **CI / Continuous Integration** — automation that runs tests + lint on every push. Our CI is `.github/workflows/ci.yml` (pnpm install → lint → build → typecheck → vitest).
- **hot reload / HMR** — when the dev server reapplies your code change without a full page refresh. Nuxt (via Vite) gives us HMR for the SPA via `task web:dev`. The Node services get a process restart in about a second via the dev overlay (`docker/docker-compose.dev.yml`, `tsx watch`).
- **backfill** — a one-time script that fills in data that the live pipeline didn't produce yet. `scripts/backfill-rag-index.sh` indexes the existing corpus into Qdrant.
- **eval harness** — script that scores the system against a curated set of expected answers. `evals/golden-questions.yaml` is the input; `bash scripts/run-rag-eval.sh` (runs `node dist/eval/runner.js` in the api container) runs it and reports recall@K and MRR.
- **recall@K** — fraction of questions where the expected doc id is in the top K retrieved. Higher is better.
- **MRR / Mean Reciprocal Rank** — averages `1/rank` across questions. Penalises the expected doc being lower in the list. Higher is better.

---

## Domain-specific German terms (the 27 document types)

These are the document_type values the AI extracts and routes on. Most are self-explanatory; the disambiguation rules live in `services/auto-tagger/src/prompt.ts` `SYSTEM_PROMPT` and `docs/document-types.md`.

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
