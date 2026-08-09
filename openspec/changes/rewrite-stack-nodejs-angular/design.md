## Context

Today the non-Paperless stack is two Python services (`auto-tagger`, `aktenraum-api`), one shared Python library (`aktenraum-core`), and a Vite+React SPA (`apps/web`), all documented in depth in `CLAUDE.md` and `docs/`. The user wants everything replaced with Node.js/TypeScript on the backend and Angular on the frontend, migrated service-by-service (strangler-fig), with the RAG reranker moved off in-process Python HF-transformers onto `onnxruntime-node`/`transformers.js` (both confirmed via `AskUserQuestion` before this design was written).

Constraints carried over from the existing system (must be preserved, not redesigned):

- Paperless-ngx is untouched — same REST API, same gotchas (`?name__iexact=`, full-array `custom_fields` PATCH, 128-char string limit, monetary/date normalisation).
- The 8 lifecycle tags and their state machine (`ai-pending` → `ai-approved`/`ai-rejected` → `ai-propagated`/`ai-propagation-error`, plus `ai-error`, `ai-auto-approved`, `ai-low-confidence`) are a cross-service contract — worker and API must agree on them regardless of implementation language.
- One shared `docker/.env` file conventions, `WEBHOOK_SECRET`-gated internal endpoints, JWT httpOnly cookie auth, and the Postgres schema (`users`, `app_settings`, `auto_approve_rules`) all stay as-is.
- Qdrant collection schema (`aktenraum_chunks`, `DENSE_DIM`-pinned) is unaffected — only the code that writes to/reads from it changes language.

## Goals / Non-Goals

**Goals:**

- Every service the project controls (worker, API, shared library, SPA, reranker) ends up in TypeScript/Node.js + Angular, with zero Python processes remaining.
- Each migrated slice preserves its existing external contract (REST shapes, lifecycle-tag semantics, SSE event framing, Qdrant payload schema) so the other not-yet-migrated slices don't need simultaneous changes.
- Migration proceeds with a working system at every intermediate step — no "everything is broken for N weeks" window.
- The existing 239 pytest tests + the RAG eval harness (`evals/golden-questions.yaml`) + confidence-correlation script serve as the parity oracle; nothing is considered "done" until its Node/Angular counterpart passes the equivalent checks.

**Non-Goals:**

- No functional/UX redesign — this is a language and framework migration, not a product change. Any UX improvement ideas that come up during the Angular port get filed as separate future changes, not bundled here.
- No change to Paperless-ngx, Postgres schema, or Qdrant schema.
- No infrastructure migration (still Docker Compose, still the same 10-service topology shape) — Kubernetes, serverless, etc. are out of scope.
- Not attempting a big-bang rewrite — see the strangler-fig decision below.

## Decisions

### 1. Node API framework: NestJS

FastAPI's dependency-injection, router modules, and Pydantic-schema-per-route pattern (documented in the `fastapi-route-pattern` skill) map closely onto NestJS's modules/controllers/providers/DTOs. NestJS also has first-class SSE support (`@Sse()` returning an `Observable`), which `/api/ai/answer/stream` needs. Alternative considered: bare Fastify/Express — faster and lighter, but would mean hand-rolling the DI/module structure that currently keeps `aktenraum-api`'s router/service/schema layering clean; rejected because that layering is explicitly called out as a maintained convention (`fastapi-route-pattern` skill) worth preserving, not a Python-specific accident.

### 2. Node worker runtime: plain Node/TypeScript, no job-queue infra

The current auto-tagger is a single process running `asyncio.gather` over four loops sharing an in-memory `asyncio.Queue`. This is deliberately simple (no Redis-backed job queue, no multi-worker fan-out). Reimplement the same shape in Node: four `async` loops started with `Promise.all`, sharing an in-memory FIFO queue (a small custom class, or the `fastq` package). Alternative considered: BullMQ (Redis-backed queue) — rejected as scope creep; it would change the operational model (new Redis usage pattern, persistence-across-restart semantics) that nothing in the current design requires, and Redis is already in the stack only for Paperless's own task queue.

### 3. Shared library / ORM: Drizzle ORM + drizzle-kit, introspected from the existing schema

`aktenraum-api` uses SQLAlchemy 2 async + Alembic. Drizzle is the closest TypeScript analog in philosophy (explicit, SQL-shaped, migration-file-based rather than a heavy active-record layer). Because the Postgres schema (`users`, `app_settings`, `auto_approve_rules`) is not changing, the first Drizzle migration is generated via `drizzle-kit introspect` against the live schema rather than hand-authored — this guarantees the Node API attaches to the existing data without a data migration step. Alternative considered: Prisma — rejected because its generated-client model and migration engine are a bigger philosophical jump from Alembic's "you own the SQL" style, and the project's normaliser-heavy, explicit-boundary style (see `paperless-api-integration` skill) fits Drizzle's lower-magic approach better.

### 4. Schema/validation: zod, replacing Pydantic

`DocumentExtraction`, `CoercedList`/`CoercedStr` (BeforeValidator coercion for flaky small-LLM output), and FastAPI's request/response models all become zod schemas with `.preprocess()`/`.transform()` for the same coercion behavior (None→[], int-in-string-list→str, etc.). Zod is the de facto TypeScript equivalent for this exact "validate untrusted LLM JSON" use case and integrates with NestJS via `nestjs-zod` or a thin custom pipe.

### 5. Reranker: transformers.js (`@huggingface/transformers`) over `onnxruntime-node` directly

Per the user's confirmed choice, run `bge-reranker-v2-m3` in-process via transformers.js, which wraps `onnxruntime-node` and handles tokenization/pipeline plumbing (`pipeline('text-classification', ...)` for cross-encoder scoring) so the port isn't hand-rolling ONNX I/O and BPE tokenization from scratch. **This carries real risk** (see Risks) — a maintained ONNX export of `bge-reranker-v2-m3` must exist or be producible (via `optimum-cli export onnx`) before this is committed to; that verification is the first task in `tasks.md`, gating the rest of `node-shared-core`.

### 6. Angular data-fetching: `@tanstack/angular-query` (official TanStack Query Angular adapter)

The `spa-data-fetching` skill documents specific query-key shapes, invalidation rules, and a `staleTime` table that the React SPA relies on. Using the official Angular adapter for the same TanStack Query library — rather than switching to Angular's native `httpResource`/signals-only approach — preserves those exact conventions (query keys, invalidation-on-mutation, dedup-by-key) with a mechanical port instead of a redesign. Angular Router's own lazy-loading (`loadComponent`) replaces TanStack Router's lazy routes; the existing `RouteSuspense` wrapper pattern maps onto Angular's `@defer` blocks or a light custom wrapper.

### 7. Auth/crypto: `bcryptjs` (pure JS) over native `bcrypt`

The Python side already hit one bcrypt-library incompatibility (`passlib`/`bcrypt` `__about__` AttributeError, session 3365). To avoid the Node equivalent (native-binding ABI mismatches across Windows dev / Linux Docker build targets), use the pure-JS `bcryptjs` — slightly slower, but eliminates an entire class of platform-specific build failures for a stack whose dev machine is Windows and whose deploy target is Linux Docker.

### 8. Package management: extend the existing pnpm workspace

`apps/web` already uses pnpm. Rather than introducing a second Node package manager, every new TypeScript package/service (`node-shared-core`, `node-api-runtime`, `node-worker-runtime`, `angular-web-spa`) joins the same pnpm workspace, replacing the Python `uv` workspace's role once the last Python member is removed.

### 9. Interim directory naming (avoids path collisions with the still-live Python code)

New code lands at suffixed paths during the migration and is renamed once its Python/React counterpart is deleted, so there's never a period with two things trying to own the canonical name:

| Interim path (built new) | Existing path (deleted at cutover) | Final path (renamed to, post-cutover) |
| --- | --- | --- |
| `packages/core-ts/` | `packages/aktenraum-core/` (Python) | `packages/aktenraum-core/` |
| `services/api-node/` | `services/aktenraum-api/` (Python) | `services/aktenraum-api/` |
| `services/worker-node/` | `services/auto-tagger/` (Python) | `services/auto-tagger/` |
| `apps/web-angular/` | `apps/web/` (React) | `apps/web/` |

### 10. Migration order: shared core → API → SPA → worker (worker last, cut over atomically)

The API and SPA can genuinely run side-by-side with their Python/React counterparts (different nginx paths/ports, or a routing flag) because Paperless doesn't care how many things *read* from it. The worker cannot safely run side-by-side with the Python auto-tagger against the same live Paperless/Postgres/Qdrant — both would race to claim documents via lifecycle tags and could double-propagate or double-index (see Risks). So: build `node-shared-core` first (foundation, testable in isolation), then `node-api-runtime` (validate the REST contract by pointing the *existing, unmodified* React SPA at it before Angular even exists — this proves the contract independent of the frontend rewrite), then `angular-web-spa` (built against the now-stable Node API), then `node-worker-runtime` last, tested against a non-production Paperless snapshot, cut over atomically (stop Python worker, start Node worker) with the Python container's image kept warm for one rollback window.

## Risks / Trade-offs

- **[Risk] No maintained ONNX export of `bge-reranker-v2-m3` exists, or transformers.js can't hit the current ~50ms/candidate latency budget** → Mitigation: first task in `tasks.md` is a standalone spike that exports/loads the model and benchmarks rerank latency before any other `node-shared-core` work depends on it. Fallback path (already declined by the user but documented for reference): a minimal standalone Python reranker microservice, or dense-only retrieval with no rerank stage.
- **[Risk] Running the Python and Node worker against the same live Paperless instance simultaneously double-processes documents** (race on lifecycle-tag PATCH, duplicate propagation, duplicate Qdrant upserts) → Mitigation: worker migration is the one slice that is *not* strangler-parallel-live; it's built/tested against an isolated snapshot and cut over atomically per environment, never run concurrently with its Python counterpart against production data.
- **[Risk] `bcryptjs` hashes must stay compatible with existing user passwords hashed by the Python service** → Mitigation: both are bcrypt-algorithm-compatible (same hash format, `$2b$` etc.); verify with a cross-library round-trip test (hash with Python `passlib`, verify with `bcryptjs`) before the Node API takes over auth.
- **[Risk] Drizzle-introspected schema drifts from what Alembic actually has in a given deployment** (e.g. a dev DB mid-migration) → Mitigation: introspect against a freshly-migrated (`alembic upgrade head`) database as the baseline, and diff the generated Drizzle schema against `services/aktenraum-api/alembic/` model definitions before trusting it.
- **[Risk] TanStack Query's Angular adapter is less battle-tested than its React adapter** → Mitigation: pilot on the lowest-risk route (`/settings`) first; only port `/library` and `/library/$id` (the highest-traffic, highest-complexity data-fetching routes) once the pilot's invalidation/staleTime behavior is confirmed equivalent.
- **[Risk] SSE event framing (`meta`/`chunk`/`final`/`error`) might not be byte-identical between FastAPI's `StreamingResponse` and NestJS's `@Sse()`** → Mitigation: contract-test `/api/ai/answer/stream` against the *existing* React SPA's SSE consumer before Angular is built, so any framing mismatch surfaces against a known-good client.
- **[Trade-off] Two live language runtimes (and two CI pipelines, two sets of Docker images) for the migration's duration** → Accepted per the user's explicit strangler-fig choice; mitigated by deleting each Python piece immediately once its slice's parity gate passes, rather than batching all deletions at the end.
- **[Trade-off] Every doc file that describes Python/React internals (`docs/architecture.md`, `docs/development.md`, `docs/api-reference.md`, all six `.claude/skills/*.md`, `CLAUDE.md`) goes stale mid-migration** → Accepted; each is updated as part of the task group for the slice it describes, not in one giant doc pass (matches the existing binding documentation cadence in `CLAUDE.md`).

## Migration Plan

1. **Spike**: verify `bge-reranker-v2-m3` ONNX export + transformers.js latency (gates everything else).
2. **`node-shared-core`** (`packages/core-ts/`): Paperless client + normalisers + zod schemas + LLM backend abstraction + RAG chunker/vector-store client + reranker. Parity gate: TypeScript port of the existing `test_paperless.py` / `test_models.py` / `test_propagator.py` suites, all green.
3. **`node-api-runtime`** (`services/api-node/`): NestJS service consuming `core-ts`, implementing the full REST + SSE surface. Deployed alongside the Python API behind an nginx routing rule (e.g. header/cookie-gated). Parity gate: the *existing, unmodified* React SPA works against it end-to-end; RAG eval harness + confidence-correlation script both run clean against it. Once confirmed, nginx cuts `/api/*` over fully and `services/aktenraum-api/` (Python) is deleted.
4. **`angular-web-spa`** (`apps/web-angular/`): built against the now-canonical Node API. Deployed at a separate path during development; promoted to `/` once every route is manually QA'd in a real browser per `CLAUDE.md`'s UI-testing requirement. Once promoted, `apps/web/` (React) is deleted.
5. **`node-worker-runtime`** (`services/worker-node/`): built and tested against an isolated Paperless/Postgres/Qdrant snapshot (never side-by-side-live with the Python worker). Cutover is atomic per environment: stop `auto-tagger` (Python), start `worker-node`, verify webhook + poller pick up a real test document end-to-end (extraction → propagation → indexing). Python image is kept (not deleted) for one rollback window, then `services/auto-tagger/` (Python) is deleted.
6. **Rename pass**: `core-ts` → `aktenraum-core`, `api-node` → `aktenraum-api`, `worker-node` → `auto-tagger`, `web-angular` → `web`.
7. **Cleanup**: remove the `python` CI job, remove `uv`/`pyproject.toml`/`uv.lock` Python workspace config, update every doc/skill file that described the old stack, add new Node/Angular equivalents of the six `.claude/skills/*` files where the underlying gotchas still apply (e.g. Paperless API gotchas are language-agnostic and should be re-documented, not dropped).

**Rollback strategy**: within any phase before its cleanup step, the old service definition is still present in `docker/docker-compose.yml` and its image still exists — rollback is flipping the nginx routing rule (or env flag) back and `docker compose up -d` the old service. There is no rollback *after* a phase's cleanup step deletes the old code; that step only happens once the parity gate for that phase has passed and the user has explicitly confirmed (per the project's existing "never commit after a fix without confirmation" discipline, extended here to "never delete the old implementation without confirmation").

## Open Questions

- Does the reranker spike (step 1) pass its latency/quality bar? This gates whether `node-shared-core`'s reranker design (Decision 5) ships as designed or falls back to one of the alternatives noted in the Risks section.
- How should this migration sequence with the two other binding, in-flight initiatives — `docs/plans/desktop-app.md` (ADR-002, Tauri wrapping the compose stack) and `docs/plans/rag-phase-1.md` (sub-phase 1.11, model auto-pull)? Both currently assume the Python service names/layout. Recommendation (not yet confirmed with the user): pause new work on both until the corresponding Node slice lands, rather than building desktop-app/RAG-phase-1 features twice.
- Should the six `.claude/skills/*.md` files be rewritten in place (same filenames, new language-specific content) or given new names alongside the old ones during the transition? Leaning toward in-place rewrite at the same commit that deletes each Python piece, to avoid two conflicting skills matching the same trigger paths.
