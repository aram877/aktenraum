# Architecture

aktenraum is a personal document-management system. Paperless-ngx provides the
storage, OCR, and admin UI. Everything around it — German auto-classification,
inbox review, full-text RAG over OCR'd bodies, the SPA that users actually
interact with — is custom code in this repo.

This doc explains the moving parts and how a document flows through them.
Configuration knobs live in [configuration.md](configuration.md); endpoint shapes
live in [api-reference.md](api-reference.md); the document taxonomy lives in
[document-types.md](document-types.md).

---

## Services

Ten containers, defined in [`docker/docker-compose.yml`](../docker/docker-compose.yml).

| Service | Image | Role | Exposed |
|---|---|---|---|
| `paperless` | `ghcr.io/paperless-ngx/paperless-ngx:2.20.15` | DMS core, OCR, admin UI, consumer | `127.0.0.1:8000` |
| `postgres` | `postgres:15` | Hosts `paperless` and `aktenraum` databases | internal |
| `redis` | `redis:7` | Paperless task queue | internal |
| `gotenberg` | `gotenberg/gotenberg:8.31.0` | PDF conversion (Office docs → PDF) | internal |
| `tika` | `apache/tika` (digest-pinned) | Document parsing | internal |
| `qdrant` | `qdrant/qdrant:v1.17.1` | Vector store for RAG | internal (6333 REST, 6334 gRPC) |
| `auto-tagger` | local build (Node 22) | Extraction worker + RAG indexer | internal (8001 webhook) |
| `aktenraum-api` | local build (Node 22) | NestJS HTTP API for the SPA | internal (8002) |
| `nginx` | local build | Edge: SPA static + reverse proxy `/api/*` | `127.0.0.1:8080` (override via `AKTENRAUM_WEB_PORT`) |
| `backup` | local build | Daily restic backup via crond | internal |

The whole stack is bound to `127.0.0.1` on purpose — exposure to LAN/internet
is a deliberate later step (Tailscale or reverse proxy). All
inter-service traffic stays on the `internal` bridge network.

### Why each service exists

- **paperless** owns the file. Originals on disk, OCR'd text in Postgres,
  custom fields and tags as first-class entities. Everything else in the
  stack reads/writes through Paperless's REST API.
- **auto-tagger** is the AI worker. It watches for new docs, calls an LLM
  to classify + extract metadata, writes `ai_*` custom fields back to
  Paperless, and (once a user approves) copies them onto Paperless's
  native correspondent / document-type / tags / date fields.
- **aktenraum-api** is the application backend the SPA talks to. It
  proxies Paperless behind cookie auth, runs the AI ask flow
  (translate natural-language → filter, retrieve, then answer over the matches),
  orchestrates RAG retrieval at query time, and owns the `aktenraum`
  database (users, settings, auto-approve rules, type-specific fields).
- **qdrant** holds the chunked OCR text + Qwen3-Embedding-4B (2560-dim) dense embeddings.
  The auto-tagger writes to it on propagation; aktenraum-api reads from it
  on every `/ask` query.
- **nginx** is the single port the user hits. SPA assets are served from
  the same image (multi-stage Docker build); `/api/*` is reverse-proxied
  to `aktenraum-api`.
- **backup** runs `restic` inside crond every night, snapshotting data dirs +
  two live Postgres dumps (`paperless` and `aktenraum`). Retention is 7 daily / 4 weekly / 12 monthly.

---

## High-level data flow

```
┌─────────┐  PDF in   ┌──────────────┐ post_consume_script ┌──────────────┐
│  user   │──────────▶│  paperless   │────────────────────▶│ auto-tagger  │
└─────────┘           │  (consumer,  │   POST /trigger/    │ (extraction  │
                      │   OCR, DB)   │     extract         │  worker)     │
                      └──────┬───────┘                     └──────┬───────┘
                             │                                    │
                             │     PATCH custom_fields + tag      │
                             │◀───────────────────────────────────┘
                             │
        ┌────────────────────┴─────────────────────┐
        │                                          │
        │       SPA approves                       │ propagation watcher
        │       /api/inbox/{id}/approve            │ polls ai-approved
        ▼                                          ▼
   tag swap                              writes native fields,
   ai-pending → ai-approved              tag swap → ai-propagated
                                                   │
                                                   ▼
                                          ┌────────────────┐
                                          │ indexer worker │ chunks + embeds
                                          │  (auto-tagger) │ via qwen3-emb.
                                          └────────┬───────┘
                                                   │
                                                   ▼
                                          ┌────────────────┐
                                          │     qdrant     │  used by /ask
                                          └────────────────┘
```

### 1. Ingest

The user drops a PDF into `~/aktenraum/consume/` (or POSTs via the SPA's
`/upload`, which streams through aktenraum-api → Paperless's
`/api/documents/post_document/`). Paperless's consumer picks it up, runs OCR,
writes the document row, and fires `post_consume_script` —
[`docker/paperless-scripts/post_consume.sh`](../docker/paperless-scripts/post_consume.sh) —
which POSTs the new document id to `http://auto-tagger:8001/trigger/extract`.

A `WEBHOOK_SECRET` shared between Paperless and the auto-tagger is sent in
`X-Aktenraum-Secret`; empty disables auth.

### 2. Extraction

The auto-tagger (`@aktenraum/worker`, Node 22) runs five concurrent loops,
built from the `runQueueConsumer` / `runInterval` helpers in
[`services/auto-tagger/src/loops.ts`](../services/auto-tagger/src/loops.ts)
and started in [`services/auto-tagger/src/main.ts`](../services/auto-tagger/src/main.ts)
(awaited with `Promise.all`): the extraction worker + poller, the
propagation worker + poller, and the RAG indexer. Alongside them runs the
HTTP webhook server ([`webhook.ts`](../services/auto-tagger/src/webhook.ts):
`/trigger/extract`, `/trigger/propagate`, `/trigger/reindex-metadata`,
`/processing`). Each queue is an in-memory `AsyncQueue`
([`queue.ts`](../services/auto-tagger/src/queue.ts)).

```
                  Paperless's post_consume_script
                                │
                                ▼
                  POST /trigger/extract (port 8001)
                                │
   extraction
   poller ────────▶ extraction_queue ◀───── webhook handler
   (every 30s,                  │
   safety net)                  ▼
                       extraction worker
                       (drains queue,
                       per-doc fault boundary)
                                │
                                ▼
                       process_document → LLM → PATCH + tag

   propagation
   poller   ─────▶ propagation_queue ─────▶ propagation worker
   (every 30s)            ▲                 (writes native fields,
                          │                  enqueues indexing)
          POST /trigger/propagate
          (fired by the api on approve)
                                                   │
                                                   ▼
                                            indexer worker
                                            (chunk + embed + Qdrant upsert)
```

For each document the worker does:

1. Re-fetch by id; skip if any lifecycle tag is already set (race protection
   against the webhook+poller firing on the same doc).
2. Resolve the extraction model: with `LLM_BACKEND=ollama` the worker asks
   `GET /api/settings/active-llm-model` (secret-gated, 60 s cache in
   [`active-model.ts`](../services/auto-tagger/src/active-model.ts)) for the
   model picked in `/settings`, reusing the last good value on a blip and
   falling back to `OLLAMA_MODEL` only on a cold failure.
3. Build the prompt: base SYSTEM_PROMPT + optional per-correspondent history
   hint + optional few-shot exemplars from the propagated corpus.
4. Call the LLM (Ollama or Anthropic). Validate output through the
   `DocumentExtractionSchema` zod schema (`@aktenraum/core`). The schema has
   coercing preprocessors (`CoercedListSchema`, `CoercedStrSchema`) for the
   things small local models routinely get wrong (null instead of `[]`, ints
   in string lists). Ollama calls are bounded by `LLM_TIMEOUT_SECONDS`; a
   transient failure (connection refused, timeout, 429/5xx) leaves the doc
   untagged for the poller to retry, and the third transient failure tags
   `ai-error`.
5. Synthesize `ai_title`, `ai_summary_de`, `ai_confidence_reason`, and
   `ai_reference_numbers` if the LLM dropped them (small models ≤8B
   routinely do). Summary + title + confidence-reason fall back to
   deterministic German prose composed from the structured fields; the
   reference-number sweep is a regex over the OCR text (Aktenzeichen,
   Rechnungsnr., Vertragsnr., …).
6. PATCH the 12 `ai_*` custom fields onto the Paperless document in one
   request. Date strings get normalised to `YYYY-MM-DD`, monetary values
   to `<ISO><amount>`, strings truncated to 128 chars (the Paperless field
   limit) unless they are `longtext` fields (currently `ai_summary_de`,
   `ai_confidence_reason`, `ai_error_message`).
7. Apply lifecycle tag(s) based on the per-`DocumentType` auto-approve
   rule + the doc's confidence (see
   [`services/auto-tagger/src/routing.ts`](../services/auto-tagger/src/routing.ts),
   [`services/auto-tagger/src/auto-approve-config.ts`](../services/auto-tagger/src/auto-approve-config.ts)
   and [`services/aktenraum-api/src/settings/settings.service.ts`](../services/aktenraum-api/src/settings/settings.service.ts)):
   - `rule.enabled = true` AND `confidence ≥ rule.min_confidence` →
     `ai-approved` + `ai-auto-approved` (skip review, propagation will fire)
   - `rule.enabled = false` for this type → `ai-pending` with reason
     `type_disabled`
   - `rule.enabled = true` but confidence below the per-type threshold
     → `ai-pending` with reason `confidence_below_min`
   - rules unreachable at cold start (api down before the auto-tagger
     boots) → fail-closed: `ai-pending` with reason
     `rules_unreachable_fail_closed`
   - additionally `ai-low-confidence` if confidence <
     `LOW_CONFIDENCE_THRESHOLD` (and the doc didn't auto-approve)

   Rules live in the aktenraum-api `auto_approve_rules` table, are
   edited from `/settings → Auto-Genehmigung` in the SPA, and the
   auto-tagger fetches them over HTTP (`GET /api/settings/active-auto-approve-rules`,
   secret-gated via `WEBHOOK_SECRET`) with a 60-second in-process TTL
   cache. Changes saved in the SPA take up to one minute to take effect
   on the next routing decision.
8. **Pass 2** — type-specific extraction
   ([`services/auto-tagger/src/type-fields.ts`](../services/auto-tagger/src/type-fields.ts)).
   The generic pass extracts the same 12 fields for every document; after
   the lifecycle tags are applied, pass 2 calls the LLM again with the
   per-type field list from `TYPE_FIELD_SCHEMA` (Rechnung has
   `rechnungsnummer`/`gesamtbetrag`/…, Krankschreibung has `au_von`/`au_bis`/…)
   and PATCHes the result to `aktenraum-api`
   `PATCH /api/documents/:id/type-fields` (secret-gated), which stores it in
   the `document_type_fields` table of the `aktenraum` database. Non-fatal:
   failures are logged and don't affect the lifecycle tag.

### 3. Review

`ai-pending` documents appear in the SPA's review queue at
`/library?tab=review` (there is no bare `/inbox` route; it falls through to
the not-found page). Opening a row goes to `/inbox/[id]`. The two-pane view
shows the PDF on the left and the 12 editable AI fields on the right.
Keyboard shortcuts: `a` Approve, `r` Reject, `j/k` next/prev, `Esc` back to
list. Multi-select bulk approve is available from the list.

User actions:

| Action | Effect |
|---|---|
| **Approve** | Tag swap `ai-pending` → `ai-approved` (optionally PATCH edited fields in the same request), then a best-effort `POST /trigger/propagate` to the auto-tagger; the 30 s propagation poller is the fallback. |
| **Reject** | Tag swap `ai-pending` → `ai-rejected`. No propagation, doc is untouched. |
| **Edit + Save** | PATCH the AI fields only. Doc stays in pending state until approved. |
| **Reprocess** | Clear all lifecycle tags, ping the auto-tagger webhook. Doc re-enters extraction with the current model + prompt. |
| **Retag (manual)** | Remove every `ai-*` tag in Paperless → poller picks it up within 30s. |

### 4. Propagation

The propagation worker in the auto-tagger
([`services/auto-tagger/src/propagate.ts`](../services/auto-tagger/src/propagate.ts))
drains the propagation queue, fed by the `/trigger/propagate` webhook and
by a poller that scans every 30 s for `ai-approved` documents. For each doc
it skips anything that no longer carries `ai-approved`
(`skip_not_approved`), then:

1. Reads the AI fields (`ai_correspondent`, `ai_document_type`,
   `ai_issue_date`, `ai_suggested_tags`, `ai_title`).
2. Looks up or creates Paperless's native Correspondent, DocumentType, and
   Tag entities by exact name (`?name__iexact=`).
3. Single PATCH sets `correspondent`, `document_type`, `created_date`,
   `title`, and merges suggested + lifecycle tags.
4. Runs the field-based duplicate detector (`@aktenraum/core` `dedup.ts`)
   against other propagated docs from the same correspondent and tags
   matches `ai-duplicate`.
5. On success: tag swap → `ai-propagated`. On any failure:
   `ai-propagation-error` (no retry loop; manual intervention).
6. Enqueues the doc id for the indexer worker.

### 5. RAG indexing

The indexer worker (fifth loop in the auto-tagger,
[`services/auto-tagger/src/indexer.ts`](../services/auto-tagger/src/indexer.ts))
drains the indexing queue and for each doc:

1. Fetch the document from Paperless (including the full OCR'd content).
2. Chunk paragraph-aware at ~500 tokens with ~50-token overlap (cap 200
   chunks per doc to protect against OCR runaway).
3. Batch-embed all chunks via Ollama `qwen3-embedding:4b` (one round-trip
   per doc).
4. Only after embedding succeeds, delete prior chunks for this doc id from
   Qdrant (idempotent — re-index never duplicates, and an Ollama outage
   never removes a doc from search).
5. Upsert with denormalised payload (doc_type, correspondent, tags,
   created_date) so we can filter at query time without a Paperless
   round-trip.

Star/unstar enqueues a metadata-only job (`/trigger/reindex-metadata`) that
rewrites the payload without re-chunking or re-embedding. Because the queue
is in-memory, the worker enqueues every `ai-propagated` doc with zero chunks
on startup (`index_reconcile_completed`).

Failures tag `ai-index-error` (auxiliary, NOT a lifecycle tag). Success
self-heals — clears the error tag if previously set.

Opt-in via `QDRANT_URL`: empty disables both the indexer and the query-time
retrieval, so extraction + propagation still work in a RAG-less deployment.

### 6. Query (Ask AI)

`/api/ai/answer/stream` is a two-LLM-call SSE pipeline
([`services/aktenraum-api/src/ai/ai.controller.ts`](../services/aktenraum-api/src/ai/ai.controller.ts)):

```
   user question (German)
       │
       ▼
   LLM call #1: extract SearchFilter (doc_type, correspondent, dates, text)
       │
       ▼
   Paperless query (document_type__id + correspondent__id, NOT bare names)
       │                                   → SSE: meta
       ▼
   RAG retrieval (when QDRANT_URL set):
     embed(question) → Qdrant dense top-50 (payload filter from SearchFilter;
                       retried unfiltered if a type/correspondent filter
                       returns nothing)
                     → bge-reranker-v2-m3 (batches of 8) → top-5 chunks
       │
       ▼
   no Paperless matches AND no RAG chunks? → "nicht gefunden" + final
       │
       ▼
   prompt slots (max 15): docs owning RAG chunks first (rank order),
     then the remaining structural matches
       │
       ▼
   LLM call #2 (streaming): the answer model reads the candidate docs'
     AI metadata + type-specific fields + the top-5 RAG chunks, writes
     German prose with [Quelle: <id>] markers. Citation ids are
     intersected with the prompt set so hallucinated ones are dropped.
       │
       ▼
   SSE: chunk* → final
```

Retrieval is dense-only (no sparse/hybrid vectors yet) followed by the
cross-encoder rerank. If RAG is disabled or any stage fails, the pipeline
degrades gracefully — the answer step falls back to AI-metadata-only.
`bge-reranker-v2-m3` (the q8 ONNX export, run via `@huggingface/transformers`
in `@aktenraum/core` `rag/reranker.ts`) is **pre-warmed at startup** as a
background task (`services/aktenraum-api/src/ai/retrieval.module.ts`) and
cached in the `aktenraum-node-hf-cache` named volume, so the first `/ask`
after a rebuild does NOT block on the HuggingFace download; rebuilds reuse
the volume. A shared in-flight load promise makes concurrent requests
during warm-up wait on the existing load instead of double-downloading.

Denial suppression: when the answer LLM emits the "I couldn't find that"
template (`DENIAL_RE` in `ai/ai.service.ts`), the back-fill rule that
would otherwise attach the retrieved set as citations is skipped — so
a "nicht gefunden" message doesn't render with source cards beneath it.

---

## Data stores

| Store | Owns |
|---|---|
| Paperless filesystem (`$AKTENRAUM_DATA_DIR/data/`, `media/`, `consume/`, `export/`) | Original files, thumbnails, archive copies |
| Postgres `paperless` DB | Paperless documents, OCR text, custom fields, tags, correspondents |
| Postgres `aktenraum` DB | aktenraum-api `users`, `app_settings` (live LLM models), `auto_approve_rules`, `document_type_fields` (pass 2) |
| Qdrant `$AKTENRAUM_DATA_DIR/qdrant/` | RAG chunks + Qwen3-Embedding-4B vectors + denormalised payload |
| Restic repo `$AKTENRAUM_DATA_DIR/backup/restic-repo/` | Encrypted snapshots of everything above |

The two Postgres databases live on the same instance because Paperless
already owns it and there's no reason to run two engines for a personal
stack. `docker/postgres-init/01-create-aktenraum-db.sh` creates the
second DB on a fresh `pgdata` volume.

Both Paperless and aktenraum-api set up their schema on container start —
Paperless via its own migration runner, aktenraum-api via `applySchema()`,
which applies `services/aktenraum-api/src/db/schema.sql` (idempotent
`CREATE TABLE IF NOT EXISTS`) in one transaction before `NestFactory.create`.
The Drizzle model in `src/db/schema.ts` must stay in sync with it.

---

## SPA routes

The SPA lives at `apps/web/` (Nuxt 4 in SPA mode, `ssr: false`, Vue 3 +
TanStack Vue Query + Tailwind v4; see [ADR-008](adr/008-nuxt-vue-frontend.md)).
`nuxt generate` writes static files that nginx serves; there is no Node
runtime at the edge. Routes come from the files under `apps/web/app/pages/`.
Every route except `/login` and `/health` opts into the `auth` route
middleware, which redirects unauthenticated visitors to `/login`.

| Route | Page | Purpose |
|---|---|---|
| `/` | `index.vue` | Landing page with quick links |
| `/login` | `login.vue` | Username/password → httpOnly JWT cookie (`guest` middleware, bare layout) |
| `/health` | `health.vue` | API health check (no auth, bare layout) |
| `/ask` | `ask.vue` | Conversational Q&A with SSE-streamed German answers + citations |
| `/library` | `library/index.vue` | Filterable list. `?tab=review` shows pending; default shows archive |
| `/library/[id]` | `library/[id].vue` | Two-pane review/edit on any non-pending doc |
| `/upload` | `upload.vue` | Drag-and-drop, per-file progress, lifecycle polling |
| `/trash` | `trash.vue` | Papierkorb — restore / Endgültig löschen / Empty trash |
| `/settings` | `settings.vue` | LLM model picker, per-type Auto-Genehmigung rules, password change |
| `/inbox/[id]` | `inbox/[id].vue` | Two-pane review on a pending doc (keyboard shortcuts) |
| anything else | `[...slug].vue` | Not-found page |

The Review tab inside `/library?tab=review` supports multi-select bulk
approve via a sticky action bar and uses Vue Query's `useInfiniteQuery`
(pageSize=50) instead of page-jump pagination so selections span
already-loaded chunks naturally.

A global Nav ([`apps/web/app/components/AppNav.vue`](../apps/web/app/components/AppNav.vue))
shows an "N in Bearbeitung" pill (auto-tagger backlog), an inbox count
badge, and a Papierkorb badge. They are driven by a single
`GET /api/events/counts` SSE stream so changes show up within ~3s of
backend state without per-badge polling.

The SPA is mobile-responsive: below `md:` (768px) the Nav collapses to a
hamburger drawer, the Library table swaps to a card list, and detail pages
get a "PDF / Bearbeiten" tab toggle.

---

## Lifecycle tags

Bootstrapped by [`scripts/bootstrap-paperless.sh`](../scripts/bootstrap-paperless.sh).
Six tags are core lifecycle states (the canonical list lives in
`packages/aktenraum-core/src/paperless/client.ts`
`LIFECYCLE_TAGS`); the rest are auxiliary flags that coexist with a
lifecycle tag and never appear alone in the state machine.

### Lifecycle states

| Tag | Colour | State |
|---|---|---|
| `ai-pending` | amber | Extracted, waiting for human review |
| `ai-approved` | green | User approved → propagation watcher will copy to native fields |
| `ai-rejected` | grey | User rejected → no propagation, doc untouched |
| `ai-propagated` | blue | Native correspondent/document_type/tags/title written; final success state |
| `ai-propagation-error` | red | Propagation failed mid-run; manual intervention needed |
| `ai-error` | red | Extraction failed (LLM error, schema validation, etc.) |

### Auxiliary flags

| Tag | Colour | Meaning |
|---|---|---|
| `ai-auto-approved` | emerald | Set alongside `ai-approved` when the per-type auto-approve rule fires (rule.enabled + confidence ≥ rule.min_confidence). The SPA renders "Auto-genehmigt". Persists through propagation. |
| `ai-low-confidence` | orange | Set alongside `ai-pending` when confidence < `LOW_CONFIDENCE_THRESHOLD`. The review queue highlights these rows with an amber left border. |
| `ai-duplicate` | purple | Set by the propagator's dedup helper when the new doc matches another propagated doc on correspondent + issue_date + doc_type + (amount or reference number). |
| `ai-duplicate-dismissed` | grey | Sticky: added when the user clicks "Kein Duplikat". Suppresses re-flagging on future propagations against the same cluster. |
| `ai-index-error` | red | RAG indexer (chunk + embed + Qdrant upsert) failed. Self-heals on the next successful indexing. NOT a lifecycle state. |
| `email-ingested` | sky | Provenance flag: arrived via IMAP (`AKTENRAUM_MAIL_*`). |
| `wichtig` | amber | User marker: starred / important. Sorted first in tag chips, rendered as a gold star pill. |

The poller excludes the six lifecycle tags from its scan; the worker
re-checks on dequeue and logs `skip_already_processed` if any lifecycle
tag is set (handles webhook+poller race).

---

## AI custom fields (Paperless)

12 fields written by the auto-tagger on every successful extraction.
Created by `scripts/bootstrap-paperless.sh`:

| Name | Type | Purpose |
|---|---|---|
| `ai_document_type` | string | One of the 27 enum values (see [document-types.md](document-types.md)) |
| `ai_correspondent` | string | Sender / counterparty / issuing authority |
| `ai_title` | string | German display title (~5–8 words). Synthesized server-side if the LLM drops it |
| `ai_issue_date` | date | YYYY-MM-DD, the document's own issue date (not birthdays / employment ranges) |
| `ai_reference_numbers` | string | Comma-joined reference / contract / file numbers |
| `ai_suggested_tags` | string | Comma-joined tags the LLM proposes (merged into Paperless tags on propagation) |
| `ai_summary_de` | longtext | Exactly 3 German sentences. Synthesized deterministically if the LLM drops it |
| `ai_confidence` | float | 0.0–1.0; drives auto-approve routing per-type |
| `ai_confidence_reason` | longtext | One German sentence explaining what drove the confidence value. Synthesized if dropped |
| `ai_backend` | string | `ollama` or `anthropic` |
| `ai_model` | string | Specific model id used (`qwen2.5:14b-instruct-q8_0`, `claude-sonnet-4-6`, …) |
| `ai_error_message` | longtext | Set on extraction or propagation failure with a German one-liner the SPA renders |

Paperless's `data_type=string` has a hard 128-char limit; `data_type=longtext`
has no cap. The `truncate_for_field` helper at the PATCH boundary
(`@aktenraum/core` `paperless/normalisers.ts`) consults `LONGTEXT_FIELDS`
(`ai_summary_de`, `ai_confidence_reason`, `ai_error_message`) and skips
truncation for those.

Per-type ("pass 2") extracted fields are stored in the `aktenraum`
database (`document_type_fields`), not Paperless, so they don't bloat the
Paperless custom-field schema. They are exposed via the
`/api/documents/{id}/type-fields` endpoint and rendered by the SPA's
`TypeSpecificFieldsSection`.

---

## Auth & networking

- The SPA authenticates with username + password → HS256 JWT in an
  httpOnly `SameSite=Lax` cookie. The token is never reachable from JS.
- nginx proxies `/api/*` to `aktenraum-api` (port 8002 inside the network);
  everything else is the SPA static bundle.
- aktenraum-api holds the Paperless API token server-side — the SPA never
  sees it. All Paperless reads (preview, download, search) proxy through
  aktenraum-api endpoints so the token can't be exfiltrated client-side.
- aktenraum-api's CSRF middleware rejects cross-site state-changing
  requests; internal callers (auto-tagger, paperless `post_consume`)
  authenticate with `X-Aktenraum-Secret` (ADR-003).
- nginx is published on `127.0.0.1:8080` only. Exposing beyond localhost
  is a deliberate later step (see ADR-002 and the desktop-app plan).

---

## Code layout

```
apps/web/                  Nuxt 4 SPA (ssr: false) + Vue 3 + TanStack Vue Query + Tailwind v4
packages/aktenraum-core/   @aktenraum/core — shared TS lib, ESM (models, LLM backends, paperless client, RAG)
services/
  auto-tagger/             @aktenraum/worker — extraction + propagation + webhook + indexer (Node 22)
  aktenraum-api/           @aktenraum/api — NestJS (ESM) HTTP API, drizzle + schema.sql, eval harness
docker/                    docker-compose.yml + per-service env templates + nginx config
scripts/                   bootstrap, backup, RAG backfill, migrations
evals/                     RAG golden questions for the eval harness
docs/
  adr/                     Architecture Decision Records
  plans/                   Multi-phase roadmaps (custom-frontend, desktop-app, rag-phase-1)
  runbooks/                Operational guides (first-time setup, restore, key rotation)
  sessions/                Daily session summaries
openspec/                  OpenSpec change proposals
```

The whole codebase is TypeScript in a single pnpm workspace
(`pnpm-workspace.yaml`: `apps/*`, `services/*`, `packages/*`) with one
`pnpm-lock.yaml`. `pnpm --filter <package> <task>` targets one package
(`@aktenraum/core`, `@aktenraum/api`, `@aktenraum/worker`, `@aktenraum/web`).

For the day-to-day development workflow see [development.md](development.md).
