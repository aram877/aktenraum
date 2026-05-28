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
| `paperless` | `ghcr.io/paperless-ngx/paperless-ngx` | DMS core, OCR, admin UI, consumer | `127.0.0.1:8000` |
| `postgres` | `postgres:15` | Hosts `paperless` and `aktenraum` databases | internal |
| `redis` | `redis:7` | Paperless task queue | internal |
| `gotenberg` | `gotenberg/gotenberg:8` | PDF conversion (Office docs → PDF) | internal |
| `tika` | `apache/tika` | Document parsing | internal |
| `qdrant` | `qdrant/qdrant:v1.17.1` | Vector store for RAG | internal (6333 REST, 6334 gRPC) |
| `auto-tagger` | local build | Extraction worker + RAG indexer | internal (8001 webhook) |
| `aktenraum-api` | local build | FastAPI for the SPA | internal (8002) |
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
  proxies Paperless behind cookie auth, runs the AI find/ask flows
  (translate natural-language → filter, then summarise the matches),
  and orchestrates RAG retrieval at query time.
- **qdrant** holds the chunked OCR text + bge-m3 embeddings.
  The auto-tagger writes to it on propagation; aktenraum-api reads from it
  on every `/ask` query.
- **nginx** is the single port the user hits. SPA assets are served from
  the same image (multi-stage Docker build); `/api/*` is reverse-proxied
  to `aktenraum-api`.
- **backup** runs `restic` inside crond every night, dumping data dirs +
  a live Postgres pipe. Retention is 7 daily / 4 weekly / 12 monthly.

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
                                          │  (auto-tagger) │ via bge-m3
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

The auto-tagger runs up to six concurrent asyncio tasks via `asyncio.gather`
in [`services/auto-tagger/src/auto_tagger/main.py`](../services/auto-tagger/src/auto_tagger/main.py):
the extraction worker + poller, the propagation worker + poller, the
RAG indexer, and the aiohttp webhook server.

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
   (every 30s)                              (writes native fields,
                                             enqueues indexing)
                                                   │
                                                   ▼
                                            indexer worker
                                            (chunk + embed + Qdrant upsert)
```

For each document the worker does:

1. Re-fetch by id; skip if any lifecycle tag is already set (race protection
   against the webhook+poller firing on the same doc).
2. Build the prompt: base SYSTEM_PROMPT + optional per-correspondent history
   hint + optional few-shot exemplars from the propagated corpus.
3. Call the LLM (Ollama or Anthropic). Validate output through
   `DocumentExtraction` Pydantic schema. The schema has coercion validators
   (`CoercedList`, `CoercedStr`) for the things small local models routinely
   get wrong (null instead of `[]`, ints in string lists).
4. Synthesize `ai_title`, `ai_summary_de`, `ai_confidence_reason`, and
   `ai_reference_numbers` if the LLM dropped them (small models ≤8B
   routinely do). Summary + title + confidence-reason fall back to
   deterministic German prose composed from the structured fields; the
   reference-number sweep is a regex over the OCR text (Aktenzeichen,
   Rechnungsnr., Vertragsnr., …).
5. PATCH the 12 `ai_*` custom fields onto the Paperless document in one
   request. Date strings get normalised to `YYYY-MM-DD`, monetary values
   to `<ISO><amount>`, strings truncated to 128 chars (the Paperless field
   limit) unless they are `longtext` fields (currently `ai_summary_de`,
   `ai_confidence_reason`, `ai_error_message`).
6. Apply lifecycle tag(s) based on the per-`DocumentType` auto-approve
   rule + the doc's confidence (see
   [`services/auto-tagger/src/auto_tagger/auto_approve_config.py`](../services/auto-tagger/src/auto_tagger/auto_approve_config.py)
   and [`services/aktenraum-api/src/aktenraum_api/settings/auto_approve_service.py`](../services/aktenraum-api/src/aktenraum_api/settings/auto_approve_service.py)):
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
7. **Pass 2** — type-specific extraction. The generic pass extracts the
   same 12 fields for every document; pass 2 calls the LLM again with a
   per-type schema (Rechnung has `rechnungsnummer`/`gesamtbetrag`/…,
   Krankschreibung has `au_von`/`au_bis`/…) and stores results in the
   `aktenraum` database via `aktenraum-api`. Non-fatal: failures don't
   block the lifecycle tag.

### 3. Review

`ai-pending` documents appear in the SPA's review queue at
`/library?tab=review` (legacy `/inbox` redirects there). The two-pane view
shows the PDF on the left and the 12 editable AI fields on the right.
Keyboard shortcuts: `a` Approve, `r` Reject, `j/k` next/prev, `Esc` back to
list. Multi-select bulk approve is available from the list.

User actions:

| Action | Effect |
|---|---|
| **Approve** | Tag swap `ai-pending` → `ai-approved` (optionally PATCH edited fields in the same request). Propagation watcher will pick it up. |
| **Reject** | Tag swap `ai-pending` → `ai-rejected`. No propagation, doc is untouched. |
| **Edit + Save** | PATCH the AI fields only. Doc stays in pending state until approved. |
| **Reprocess** | Clear all lifecycle tags, ping the auto-tagger webhook. Doc re-enters extraction with the current model + prompt. |
| **Retag (manual)** | Remove every `ai-*` tag in Paperless → poller picks it up within 30s. |

### 4. Propagation

A second polling loop in the auto-tagger
([`services/auto-tagger/src/auto_tagger/propagator.py`](../services/auto-tagger/src/auto_tagger/propagator.py))
scans every 30 s for `ai-approved` documents and:

1. Reads the AI fields (`ai_correspondent`, `ai_document_type`,
   `ai_issue_date`, `ai_suggested_tags`, `ai_title`).
2. Looks up or creates Paperless's native Correspondent, DocumentType, and
   Tag entities by exact name (`?name__iexact=`).
3. Single PATCH sets `correspondent`, `document_type`, `created_date`,
   `title`, and merges suggested + lifecycle tags.
4. On success: tag swap → `ai-propagated`. On any failure:
   `ai-propagation-error` (no retry loop; manual intervention).
5. Enqueues the doc id for the indexer worker.

### 5. RAG indexing

The indexer worker (fifth asyncio task in the auto-tagger) drains the
indexing queue and for each doc:

1. Fetch the document from Paperless (including the full OCR'd content).
2. Chunk paragraph-aware at ~500 tokens with ~50-token overlap (cap 200
   chunks per doc to protect against OCR runaway).
3. Batch-embed all chunks via Ollama bge-m3 (one round-trip per doc).
4. Delete prior chunks for this doc id from Qdrant (idempotent — re-index
   never duplicates).
5. Upsert with denormalised payload (doc_type, correspondent, tags,
   created_date) so we can filter at query time without a Paperless
   round-trip.

Failures tag `ai-index-error` (auxiliary, NOT a lifecycle tag). Success
self-heals — clears the error tag if previously set.

Opt-in via `QDRANT_URL`: empty disables both the indexer and the query-time
retrieval, so extraction + propagation still work in a RAG-less deployment.

### 6. Query (Ask AI)

`/api/ai/answer/stream` is a two-step SSE pipeline:

```
   user question (German)
       │
       ▼
   LLM call #1: extract SearchFilter (doc_type, correspondent, dates, text)
       │
       ▼
   Paperless query (document_type__id + correspondent__id, NOT bare names)
       │
       ▼
   RAG retrieval (when QDRANT_URL set):
     embed(question) → Qdrant top-50 (payload filter from SearchFilter)
                     → bge-reranker-v2-m3 → top-5 chunks
       │
       ▼
   LLM call #2 (streaming): the answer model reads the candidate docs'
     AI metadata + the top-5 RAG chunks, writes German prose with
     [Quelle: <id>] markers. Citation ids are intersected with the
     retrieved set so hallucinated ones are dropped.
       │
       ▼
   SSE: meta → chunk* → final
```

If RAG is disabled or any stage fails, the pipeline degrades gracefully —
the answer step falls back to AI-metadata-only. `bge-reranker-v2-m3` is
**pre-warmed in lifespan** as a background task (`aktenraum_api.main._warm_reranker`)
and cached in the `aktenraum-hf-cache` named volume, so the first `/ask`
after a rebuild does NOT block on the ~2.1 GB HuggingFace download. A
fresh-host cold start takes ~80s; rebuilds reuse the volume and are
instant. An `asyncio.Lock` makes concurrent requests during warm-up
wait on the in-flight load instead of double-downloading.

Denial suppression: when the answer LLM emits the "I couldn't find that"
template (`_DENIAL_RE` in `ai/router.py`), the back-fill rule that
would otherwise attach the retrieved set as citations is skipped — so
a "nicht gefunden" message doesn't render with source cards beneath it.

---

## Data stores

| Store | Owns |
|---|---|
| Paperless filesystem (`~/aktenraum/data/`, `media/`, `consume/`, `export/`) | Original files, thumbnails, archive copies |
| Postgres `paperless` DB | Paperless documents, OCR text, custom fields, tags, correspondents |
| Postgres `aktenraum` DB | aktenraum-api users (`auth_users`), per-type extracted fields (pass 2) |
| Qdrant `~/aktenraum/qdrant/` | RAG chunks + bge-m3 embeddings + denormalised payload |
| Restic repo `~/aktenraum/backup/restic-repo/` | Encrypted snapshots of everything above |

The two Postgres databases live on the same instance because Paperless
already owns it and there's no reason to run two engines for a personal
stack. `docker/postgres-init/01-create-aktenraum-db.sh` creates the
second DB on a fresh `pgdata` volume.

Both Paperless and aktenraum-api migrate themselves on container start —
Paperless via its own migration runner, aktenraum-api via
`alembic upgrade head` in its entrypoint.

---

## SPA routes

The SPA lives at `apps/web/` (Vite + React 19 + TanStack Router/Query +
Tailwind v4). Every route except `/login` requires a valid auth cookie;
unauthenticated requests redirect to `/login`.

| Route | Component | Purpose |
|---|---|---|
| `/` | `Home` | Landing page with quick links |
| `/login` | `Login` | Username/password → httpOnly JWT cookie |
| `/ask` | `Ask` | Conversational Q&A with SSE-streamed German answers + citations |
| `/find` | `Find` | Structured search — closed-enum filter (chips editable) |
| `/library` | `Library` | Filterable list. `?tab=review` shows pending; default shows archive |
| `/library/$id` | `LibraryReview` | Two-pane review/edit on any non-pending doc |
| `/upload` | `Upload` | Drag-and-drop, per-file progress, lifecycle polling |
| `/scan` | `Scan` | Mobile camera capture + client-side PDF composition via `pdf-lib` |
| `/trash` | `Trash` | Papierkorb — restore / Endgültig löschen / Empty trash |
| `/settings` | `Settings` | LLM model picker, per-type Auto-Genehmigung rules, password change |
| `/inbox` | (redirect) | Legacy — redirects to `/library?tab=review` |
| `/inbox/$id` | `InboxReview` | Two-pane review on a pending doc (keyboard shortcuts) |

The Review tab inside `/library?tab=review` supports multi-select bulk
approve via a sticky action bar and uses TanStack `useInfiniteQuery`
(pageSize=50) instead of page-jump pagination so selections span
already-loaded chunks naturally.

A global Nav ([`apps/web/src/components/Nav.tsx`](../apps/web/src/components/Nav.tsx))
shows an "N in Bearbeitung" pill (auto-tagger backlog), an inbox count
badge, and a Papierkorb badge. They are driven by a single
`GET /api/events/counts` SSE stream so changes show up within ~3s of
backend state without per-badge polling.

The SPA is mobile-responsive: below `md:` (768px) the Nav collapses to a
hamburger drawer, the Library table swaps to a card list, detail pages
get a "PDF / Bearbeiten" tab toggle, and `DocumentPreviewModal` goes
full-screen.

---

## Lifecycle tags

Bootstrapped by [`scripts/bootstrap-paperless.sh`](../scripts/bootstrap-paperless.sh).
Six tags are core lifecycle states (the canonical list lives in
`packages/aktenraum-core/src/aktenraum_core/paperless/client.py`
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
| `ai-low-confidence` | orange | Set alongside `ai-pending` when confidence < `LOW_CONFIDENCE_THRESHOLD`. SPA pins these to the top of the review queue. |
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
| `ai_model` | string | Specific model id used (`qwen2.5:32b-instruct-q8_0`, `claude-sonnet-4-6`, …) |
| `ai_error_message` | longtext | Set on extraction or propagation failure with a German one-liner the SPA renders |

Paperless's `data_type=string` has a hard 128-char limit; `data_type=longtext`
has no cap. The `truncate_for_field` helper at the PATCH boundary
consults `LONGTEXT_FIELDS = {"ai_summary_de", "ai_confidence_reason",
"ai_error_message"}` and skips truncation for those.

Per-type ("pass 2") extracted fields are stored in the `aktenraum`
database, not Paperless, so they don't bloat the Paperless custom-field
schema. They are exposed via the `/api/documents/{id}/type-fields` endpoint
and rendered by the SPA's `TypeSpecificFieldsSection`.

---

## Auth & networking

- The SPA authenticates with username + password → HS256 JWT in an
  httpOnly `SameSite=Lax` cookie. The token is never reachable from JS.
- nginx proxies `/api/*` to `aktenraum-api` (port 8002 inside the network);
  everything else is the SPA static bundle.
- aktenraum-api holds the Paperless API token server-side — the SPA never
  sees it. All Paperless reads (preview, download, search) proxy through
  aktenraum-api endpoints so the token can't be exfiltrated client-side.
- nginx is published on `127.0.0.1:8080` only. Exposing beyond localhost
  is a deliberate later step (see ADR-002 and the desktop-app plan).

---

## Code layout

```
apps/web/                  Vite + React 19 + TanStack Router/Query + Tailwind v4 SPA
packages/aktenraum-core/   Shared Python lib (models, LLM backends, paperless client, RAG)
services/
  auto-tagger/             Extraction worker + propagator + webhook + indexer
  aktenraum-api/           FastAPI HTTP API, Alembic migrations, eval harness
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

The Python side is a single uv workspace; `pyproject.toml` at the root
links `packages/aktenraum-core` and `services/auto-tagger` +
`services/aktenraum-api`. One `uv.lock`, one `.venv`. The web side is a
pnpm workspace; `pnpm --filter @aktenraum/web <task>` operates on the SPA.

For the day-to-day development workflow see [development.md](development.md).
