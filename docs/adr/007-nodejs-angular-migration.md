# ADR-007 — Migrate the whole stack from Python/React to Node.js/Angular

- **Status**: Accepted — frontend part superseded by
  [ADR-008](008-nuxt-vue-frontend.md) (the Angular SPA was replaced by a Nuxt 4
  / Vue SPA on 2026-10-01). The backend decisions in this ADR stand.
- **Date**: 2026-08-24
- **Deciders**: maintainer
- **Supersedes in part**: [ADR-004](004-two-python-services.md) (the two-service
  split survives; the runtime it described does not)

## Context

aktenraum ran two Python services (FastAPI `aktenraum-api`, asyncio
`auto-tagger`) sharing a `aktenraum-core` library, plus a Vite + React 19 SPA.
Everything worked. The reason to move was not that the Python was bad.

The pressure came from the seams. Four of them, in rough order of cost:

1. **Two languages, one domain model.** `DocumentType` (27 values), the
   `ai_*` custom-field names, the lifecycle-tag vocabulary, and the per-type
   field schema existed in Python and again in TypeScript, kept in sync by
   hand and by an OpenAPI codegen step. Adding a document type meant editing
   both sides and remembering the codegen. The `TYPE_FIELD_SCHEMA` in
   particular had no mechanism that could fail when a type was missing.
2. **A codegen step in the inner loop.** The SPA's types came from
   `/api/openapi.json`, which required the stack to be *running* to
   regenerate. A backend shape change that nobody regenerated for showed up
   as a runtime error in the browser, not a build error.
3. **Distribution.** Per [ADR-002](002-distribution-desktop-app.md) this ships
   as a Tauri desktop app. Tauri's tooling, the sidecar story, and the eventual
   installer are all Node-shaped. A Python runtime inside that bundle is
   another interpreter to ship, pin, and explain to a buyer's antivirus.
4. **Maintainer fluency.** One person maintains this. Two ecosystems means two
   sets of tooling, two dependency-audit habits, two debugging idioms.

## Decision

**Rewrite the entire application layer in TypeScript, in one pnpm workspace,
and delete the Python and React implementations.**

| Was | Is |
| --- | --- |
| `packages/aktenraum-core` (Python) | `packages/aktenraum-core` — `@aktenraum/core`, ESM |
| `services/aktenraum-api` (FastAPI) | `services/aktenraum-api` — `@aktenraum/api`, NestJS (ESM) |
| `services/auto-tagger` (asyncio) | `services/auto-tagger` — `@aktenraum/worker`, 5 loops |
| `apps/web` (Vite + React 19) | `apps/web` — `@aktenraum/web`, Angular 22, zoneless |
| uv workspace, ruff, pytest | pnpm workspace, eslint, vitest |
| SQLAlchemy + Alembic | Drizzle + an idempotent `schema.sql` applied at boot |

Paperless-ngx, Postgres, Redis, Qdrant, Gotenberg, Tika, nginx and the restic
backup are **unchanged**. This is a rewrite of the code we own, not of the
stack it sits in.

Things deliberately kept identical so the migration could not become a
product change:

- **The German `SYSTEM_PROMPT`, byte for byte** (14,118 characters, verified
  by hash and now pinned by a test). A reworded prompt changes classification
  on every future document, silently and forever.
- **The `{"detail": "..."}` error shape.** That is FastAPI's, and the SPA reads
  it everywhere. Keeping it meant the frontend port did not also have to be an
  error-handling port.
- **The lifecycle-tag state machine**, the routing matrix and its five
  closed-enum reasons, the fail-closed auto-approve default, and every
  Paperless boundary normaliser.

## How it was executed

Strangler-fig, in three independently reversible stages, over roughly two
weeks of sessions:

1. **Build alongside.** The Node packages landed in the same workspace as the
   Python ones. nginx gained a `map`-based switch so a request could opt into
   the Node API with `X-Aktenraum-Backend: node` or a cookie, with Python as
   the default. Nothing was deleted; the live stack was unaffected.
2. **Verify.** A pg-mem + fake-Paperless harness for the API (179 tests), a
   pure-function suite for the worker (105) and core (170), Angular's
   first-party vitest builder for the SPA (79). Then an isolated
   Paperless/Postgres/Qdrant stack (`task e2e:worker`) proving the worker's
   full pipeline end to end with 20 assertions.
3. **Cut over and delete.** Flip the nginx default, stop the Python worker,
   start the Node one, verify a real document, then remove the Python
   services, the React SPA, the uv toolchain and the switch itself.

## Consequences

**Good**

- One domain model. `DocumentType` is a TypeScript union; `TYPE_FIELD_SCHEMA`
  is `Record<DocumentType, …>`, so omitting a type is now a **compile error**
  rather than a silently missing prompt section.
- No OpenAPI codegen step. The SPA imports the shapes; a backend change that
  breaks the frontend fails `pnpm -r build`.
- One CI job, one lockfile, one lint config, one test runner.
- Two bugs were found and fixed by the port that were live in Python: a
  five-minute stale tag cache that hid freshly-propagated tags from the
  library, and a transformers.js cache landing in `node_modules` instead of
  the mounted volume.

**Bad, or at least owed**

- **Fewer tests than before.** 533 TypeScript against 669 Python. The Python
  suite had years of accumulated edge cases; some were about Python-specific
  behaviour and correctly did not survive, but not all.
- **A whole class of Python-side maturity is gone**: Alembic's migration
  history is replaced by a single idempotent `schema.sql`. That is simpler and
  adequate for a single-tenant desktop product, and would be inadequate for a
  multi-tenant service. If the product ever grows that way, this needs
  revisiting before the first destructive schema change.
- **`asyncio.shield()` has no Node equivalent** and needed none: an in-flight
  `await` is not cancelled by a signal, so lifecycle PATCHes are protected for
  free. If cancellation support is ever added, that guarantee must be
  restored explicitly.
- One cosmetic divergence remains in few-shot exemplars: Python's `json.dumps`
  renders a float default as `1.0`, `JSON.stringify` renders `1`. Only
  reachable when an exemplar has no `ai_confidence` at all.

**Reversibility**

Low, by design and by the point in time. Every Python file is recoverable from
git history, but the schema is now created by the Node service and the
compose, nginx, CI and Taskfile definitions have all moved on. Reverting means
restoring a coherent set of commits, not flipping a flag. The strangler switch
existed precisely so the reversible window happened *before* this ADR, not
after it.
