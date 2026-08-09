## Why

The non-Paperless portion of aktenraum is currently split across two languages (Python for `auto-tagger` + `aktenraum-api` + `aktenraum-core`, TypeScript/React for the SPA). The user wants to consolidate on a single language and runtime — Node.js/TypeScript on the backend, Angular on the frontend — for the entire stack the project controls, so future work happens in one toolchain instead of two. Paperless-ngx itself (an external, unmodified image) is out of scope.

## What Changes

- Introduce a new Node.js/TypeScript worker service that reimplements the auto-tagger's four-loop pipeline (webhook listener, poller, extraction worker, propagation watcher) plus RAG indexing, against the same Paperless lifecycle-tag state machine.
- Introduce a new Node.js/TypeScript HTTP API service that reimplements the aktenraum-api BFF surface (auth, inbox, library, upload, trash, settings, AI search/answer, document proxy) with the same REST contract the SPA already depends on.
- Introduce a new TypeScript shared package that reimplements `aktenraum-core` (Paperless REST client + gotcha handling, field normalisers, schema validation of LLM output — Pydantic → zod/equivalent, LLM backend abstraction for Ollama/Anthropic, RAG chunking + Qdrant vector store client).
- Reimplement the in-process Python HF-transformers `bge-reranker-v2-m3` cross-encoder using `onnxruntime-node` / `transformers.js` so no Python process remains anywhere in the stack.
- Introduce a new Angular SPA that reimplements every existing route/page (Home, Ask, Library + review tab, Library detail, Upload, Scan, Trash, Settings, Login) against the same API contract, replacing Vite+React+TanStack Router/Query.
- Migrate service-by-service using a strangler-fig approach: each new Node/Angular slice is stood up alongside its Python/React counterpart, routed to independently (e.g. via nginx path/host rules or a feature flag), validated for parity, and only then does the old implementation get removed. The stack runs both languages simultaneously for the duration of the migration — this is expected, not a defect.
- **BREAKING** (deferred to the end of each slice's migration, not day one): `services/auto-tagger`, `services/aktenraum-api`, `packages/aktenraum-core`, and `apps/web` are deleted once their Node/Angular replacements reach parity and are cut over.
- CI gains Node/TypeScript lint + test jobs for each new service as it's introduced; the existing `python` CI job (ruff + pytest) is removed only when the last Python service is retired.
- `docker/docker-compose.yml` gains new service definitions for each Node runtime as it's introduced, and drops the corresponding Python service once retired.

## Capabilities

### New Capabilities

- `node-worker-runtime`: Node.js/TypeScript replacement for the auto-tagger — extraction, confidence-based routing, propagation, dedup, few-shot/history hints, RAG indexing — implementing the same lifecycle-tag contract as the current Python service.
- `node-api-runtime`: Node.js/TypeScript replacement for aktenraum-api — auth/session, inbox, library, upload/reprocess, trash, settings (auto-approve rules, quality tiers), AI find/answer/answer-stream, document preview/download proxy — implementing the same REST surface the SPA calls today.
- `node-shared-core`: TypeScript shared package replacing `aktenraum-core` — Paperless API client with all documented gotchas (`?name__iexact=`, full-array custom-fields PATCH, monetary/date/string normalisers, `swap_lifecycle_tag` retry), LLM backend abstraction (Ollama + Anthropic), RAG chunker, Qdrant vector store client, and the ONNX-based reranker.
- `angular-web-spa`: Angular replacement for `apps/web` — same routes, same API contract, same UX (two-pane review, keyboard shortcuts, drag-and-drop upload, mobile scan flow, processing-status polling/badges).
- `strangler-migration-routing`: The routing/deployment mechanism (nginx rules, compose service wiring, and/or a runtime flag) that lets a given capability's Node/Angular implementation and its Python/React counterpart run side-by-side, be validated independently, and be cut over without downtime.

### Modified Capabilities

_None._ This change replaces implementations behind existing behavior; it does not change any documented requirement. (`openspec/specs/` currently has no tracked capability specs to diff against — historical behavior is documented in `CLAUDE.md` and `docs/`, not in `openspec/specs/`.)

## Impact

- **Deleted (at end of migration, per-slice)**: `services/auto-tagger/`, `services/aktenraum-api/`, `packages/aktenraum-core/`, `apps/web/`, their Dockerfiles, and the Python-specific parts of `pyproject.toml` / `uv.lock`.
- **Added**: new Node/TypeScript service directories (naming TBD in design.md — e.g. `services/worker`, `services/api`, `packages/core`, `apps/web-angular` during transition), each with its own `package.json`, Dockerfile, and test suite.
- **Docker**: `docker/docker-compose.yml` carries both old and new service definitions during migration; `nginx` config gains routing rules to split traffic per slice.
- **CI**: `.github/workflows/ci.yml` gains Node jobs incrementally; the `python` job is removed only after the last Python service is retired.
- **Docs**: every doc that currently describes Python/React internals (`docs/architecture.md`, `docs/development.md`, `docs/api-reference.md`, all six `.claude/skills/*` files, `CLAUDE.md` itself) needs a corresponding rewrite once its subject matter is cut over — tracked as its own task group, not done in one pass.
- **Data model / external contracts unaffected**: Paperless-ngx, Postgres schema, Qdrant collection schema, and the REST/SSE contract the SPA consumes are all preserved as behavioral targets — this is a language/framework migration, not a functional redesign.
- **Test suite**: the existing 239 pytest tests are the parity baseline; each Node port needs an equivalent test (not necessarily line-for-line) before its Python counterpart is removed.
