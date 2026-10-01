# API reference

`aktenraum-api` (NestJS on port 8002 inside the network) is the only
service the SPA talks to. nginx reverse-proxies `/api/*` to it. All
routes are mounted under the global prefix `/api` (`app.setGlobalPrefix("api")`
in `services/aktenraum-api/src/main.ts`). Errors use the `{detail}` shape.

The auth model is a single HS256 JWT in an httpOnly `SameSite=Lax`
cookie set by `/api/auth/login`. The SPA never sees the token; the
cookie travels automatically. Endpoints marked **🔒** require a valid
cookie; unauthenticated calls return 401.

There is no OpenAPI/Swagger endpoint. The SPA has no codegen step: its
TypeScript interfaces live in `apps/web/app/{composables,utils}/*.ts` and
are kept in step with the API by hand. **Treat this doc as a map; the
controllers (`services/aktenraum-api/src/**/*.controller.ts`) and the
schema files listed under "Shape references" are the source of truth.**

---

## Health

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | — | Liveness probe. Returns `{"status": "ok"}`. |

---

## Auth — `/api/auth/*`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | — | Body `{username, password}`. Sets the `aktenraum_session` cookie. Returns `UserResponse`. |
| POST | `/api/auth/logout` | — | Clears the session cookie. 204 No Content. |
| GET  | `/api/auth/me` | 🔒 | Returns the current `UserResponse`. The SPA's router uses this to decide whether to redirect to `/login`. |
| POST | `/api/auth/change-password` | 🔒 | Body `{current_password, new_password}`. Verifies current + enforces min 8 chars + `new != current`. On success, clears the session cookie so the current device re-logs in (other devices' JWTs expire on their own). 204 No Content. |

`UserResponse`: `{id, username}`.

---

## AI features — `/api/ai/*`

When `PAPERLESS_API_TOKEN` is unset, every route here returns 503.

### POST `/api/ai/find` 🔒

Structured search. Accepts EITHER a natural-language query OR a
pre-built filter:

```ts
type AskRequest =
  | { query: string }                // LLM extracts a SearchFilter
  | { filter: SearchFilter }         // skip LLM, re-run a chip-edited filter
```

`SearchFilter` (closed enum on `document_type`):

```ts
{
  document_type?: DocumentType         // one of the 27 enum values
  correspondent?: string               // free text, exact-match against Paperless
  date_from?: date                     // ISO YYYY-MM-DD
  date_to?: date
  text?: string                        // full-text content search
  tags?: string[]                      // AND semantics
}
```

Returns `AskResponse`:

```ts
{
  filter: SearchFilter                 // the canonical filter (chip-editable)
  results: DocumentSummary[]
  explanation: string                  // German one-liner explaining the filter
  total: number
}
```

Each `DocumentSummary` carries `lifecycle_tags` so the SPA can render
a status pill on every card.

### POST `/api/ai/answer` 🔒

Two-step pipeline (filter extraction → retrieval → second LLM call).
Non-streaming variant. Body: `{question: string}`. Returns
`AnswerResponse`:

```ts
{
  question: string
  answer_de: string                    // German prose, up to 3 sentences
  citations: DocumentSummary[]         // hallucinated ids are filtered out
  filter: SearchFilter
  total: number
}
```

Use case: programmatic / non-UI consumers.

### POST `/api/ai/answer/stream` 🔒

The user-facing `/ask` endpoint. Same pipeline as `/answer` but
streamed as Server-Sent Events:

```
event: meta
data: {"filter": {...}, "explanation": "...", "total": 5}

event: chunk
data: {"text": "Die letzte "}

event: chunk
data: {"text": "Rechnung..."}

event: final
data: {"answer_de": "...", "citations": [...], "total": 5}
```

On failure the stream ends with `event: error` / `data: {"detail": "..."}`.

When `QDRANT_URL` is set, the prompt to the answer model includes the
top-5 reranked chunks from Qdrant per candidate doc; the answer is
expected to include `[Quelle: <id>]` markers inline, which are
extracted post-hoc and intersected with the retrieved set.

When `QDRANT_URL` is unset (or any RAG stage errors), the pipeline
degrades gracefully to the AI-metadata-only path.

`bge-reranker-v2-m3` (ONNX, via transformers.js) is **pre-warmed at
startup** by `RetrievalModule` as a background task and cached in the
`aktenraum-node-hf-cache` named volume. A fresh-host cold start downloads
the model once; rebuilds reuse the cache. Concurrent requests during
warm-up await the same in-flight load promise instead of
double-downloading.

---

## Documents — `/api/documents/*`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/documents/upload` | 🔒 | Multipart `files` (one or many). Streams each through to Paperless's `/api/documents/post_document/`. Per-file failure is isolated. Returns `{results: [{filename, status, task_id, detail}]}`. |
| POST | `/api/documents/{id}/reprocess` | 🔒 | Clears every lifecycle tag and pings the auto-tagger webhook. Falls back to the 30s poller if the webhook is unreachable. Returns `ReprocessResponse`. |
| GET  | `/api/documents/{id}/detail` | 🔒 | Full review payload (same shape as `/api/inbox/{id}`) — works on any doc, not just `ai-pending`. |
| PATCH | `/api/documents/{id}/fields` | 🔒 | Partial update of the 12 AI fields. Body `InboxFieldUpdate`. |
| GET  | `/api/documents/processing` | 🔒 | Current auto-tagger work in flight — extraction / propagation / indexer slot occupants. Used by the Library page to pin in-flight docs to the top of page 1. |
| GET  | `/api/documents/in-flight` | 🔒 | `{count: number}` — docs carrying `ai-pending` or `ai-approved`. The Nav badge consumes this via the `/api/events/counts` SSE stream. |
| GET  | `/api/documents/task/{uuid}` | 🔒 | Proxies Paperless's task lookup. `{task_id, status, doc_id?, result?}`. `doc_id` is regex-fallback parsed from the result string for older Paperless versions. |
| GET  | `/api/documents/{id}/status` | 🔒 | Lightweight `{id, lifecycle_tags}` lookup used by the upload-page poller. |
| GET  | `/api/documents/{id}/preview` | 🔒 | Inline PDF stream (`Content-Type: application/pdf`, `Cache-Control: private, max-age=300`). |
| GET  | `/api/documents/{id}/download` | 🔒 | Original file with upstream `Content-Disposition` forwarded. |
| POST | `/api/documents/{id}/star` | 🔒 | Adds the `wichtig` user tag (auto-creates the tag on first call), then pings the auto-tagger's `/trigger/reindex-metadata` so the Qdrant payload picks up the tag. Returns `{doc_id}`. |
| DELETE | `/api/documents/{id}/star` | 🔒 | Removes the `wichtig` tag and triggers the same metadata re-index. Returns `{doc_id}`. |
| POST | `/api/documents/{id}/dismiss-duplicate` | 🔒 | Removes the `ai-duplicate` tag and adds the sticky `ai-duplicate-dismissed` aux tag so future propagations against the same cluster don't re-flag the doc. Returns `{doc_id}`. |
| GET  | `/api/documents/{id}/duplicate-candidates` | 🔒 | Re-runs the field-based dedup detector (`packages/aktenraum-core/src/dedup.ts`) against the live corpus and returns the matching propagated docs so the detail page can render "Mögliches Duplikat von #N" links. |
| DELETE | `/api/documents/{id}` | 🔒 | **Soft-delete** (moves the doc to Paperless's trash). Recoverable for `PAPERLESS_EMPTY_TRASH_DELAY` days (default 30) until the trash is emptied. 204 No Content. Hard-delete + Qdrant chunk purge happens via `/api/trash/*`. |

---

## Inbox — `/api/inbox/*` (review queue)

Specialised endpoints for `ai-pending` documents. The `/library?tab=review`
view in the SPA uses these.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET  | `/api/inbox/` | 🔒 | Paginated list of `ai-pending` docs. Query: `page`, `page_size` (default 20, max 100), `ordering` (allowlisted, default `-modified`; unknown values fall back to the default). |
| GET  | `/api/inbox/{id}` | 🔒 | Full review payload (12 `ai_*` fields + content excerpt + tags). |
| PATCH | `/api/inbox/{id}` | 🔒 | Partial field update (`InboxFieldUpdate`). |
| POST | `/api/inbox/{id}/approve` | 🔒 | Optional body to patch fields in the same call. Tag swap `ai-pending` → `ai-approved`. Idempotent re-approve is a no-op. |
| POST | `/api/inbox/{id}/reject` | 🔒 | Tag swap `ai-pending` → `ai-rejected`. |
| GET  | `/api/inbox/{id}/preview` | 🔒 | Same PDF stream as `/api/documents/{id}/preview`. |

Tag swaps are planned by `planTagSwap` (pure helper) so the patch
body always contains the full `tags=[…]` array — Paperless's PATCH is
full-replace, not partial. The custom-fields PATCH has the same
gotcha and is handled by `mergeCustomFields`.

---

## Library — `/api/library/*` (archive view)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/library/` | 🔒 | Paginated list of non-pending docs. Server-side excludes `ai-pending`. |
| GET | `/api/library/tags` | 🔒 | Tag facet — `{name, count}` over the current corpus, used for the tag chip cloud. |

`GET /api/library/` query params:

| Param | Type | Notes |
|---|---|---|
| `document_type` | enum | One of the 27 `DocumentType` values. |
| `correspondent` | string | Exact match against Paperless. |
| `date_from` / `date_to` | date | ISO YYYY-MM-DD. |
| `text` | string | Full-text content search. |
| `tags` | string[] | AND semantics. |
| `page` | int ≥ 1 | |
| `page_size` | int 1..100 | Default 25. |
| `ordering` | enum | `-created` (default), `created`, `-modified`, `modified`, `title`, `-title`. Other values rejected with 422. |

Returns `{results: LibraryItem[], total, page, page_size}`. `LibraryItem`
carries `lifecycle_tags` (small badge per tag — propagated / approved /
rejected / error) and falls back to AI custom fields when the native
correspondent / doc_type FK is unset.

---

## Trash — `/api/trash/*`

Two-step delete model: `DELETE /api/documents/{id}` soft-deletes (moves
to Paperless's trash, recoverable). These endpoints hard-delete or
restore. Hard-delete (`/{id}/delete` + `/empty`) ALSO purges the doc's
Qdrant chunks via the vector store's `deleteByDocId`; failures log
`trash_qdrant_purge_failed` but never fail the user request (best-effort).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET  | `/api/trash/` | 🔒 | Paginated list of trashed docs. Query: `page`, `page_size`, `ordering` (`deleted_at`/`-deleted_at`/`created`/`-created`/`title`/`-title`). |
| POST | `/api/trash/{id}/restore` | 🔒 | Restore from trash. 204 No Content. |
| POST | `/api/trash/{id}/delete` | 🔒 | Hard-delete one doc + purge Qdrant chunks. 204 No Content. |
| POST | `/api/trash/empty` | 🔒 | Empty the trash (hard-delete every trashed doc + purge Qdrant chunks). Returns `EmptyTrashResponse` with the count. |

---

## Settings — `/api/settings/*`

The SPA's `/settings` page consumes the auth-gated endpoints. The
`active-*` variants are internal — the auto-tagger reads them with a
short TTL cache, secret-gated via `WEBHOOK_SECRET` when set.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET  | `/api/settings/llm` | 🔒 | Active extraction model. `{model}` — a literal Ollama tag stored in `app_settings.llm_model`. |
| PATCH | `/api/settings/llm` | 🔒 | Body `{model}` (non-empty, max 128 chars). Sets the extraction model. |
| GET  | `/api/settings/answer-llm` | 🔒 | Active answer model for `/api/ai/answer*`. `{model}` (`app_settings.answer_llm_model`). |
| PATCH | `/api/settings/answer-llm` | 🔒 | Body `{model}`. Sets the answer model. |
| GET  | `/api/settings/available-models` | 🔒 | `{models: string[]}` — the tags currently pulled in Ollama (`GET /api/tags` on `OLLAMA_BASE_URL`). Empty list when `LLM_BACKEND` is not `ollama` or Ollama is unreachable; the SPA then shows a free-text input. |
| GET  | `/api/settings/active-llm-model` | secret | Internal: auto-tagger reads the active extraction model. Returns `{ollama_model}`. No cookie needed (in-network only); `X-Aktenraum-Secret` required when `WEBHOOK_SECRET` is set. |
| GET  | `/api/settings/auto-approve` | 🔒 | `{rules: AutoApproveRule[]}` — per-`DocumentType` `enabled`, `min_confidence`, `updated_at`, `updated_by`. One row per enum value. |
| PUT  | `/api/settings/auto-approve` | 🔒 | Body `{rules: [{document_type, enabled, min_confidence}]}`. Replaces the rule set (transactional). Unknown or duplicate types are rejected. |
| GET  | `/api/settings/active-auto-approve-rules` | secret | Internal: auto-tagger reads the rules every 60s (TTL cache). No cookie needed (in-network only); `X-Aktenraum-Secret` required when `WEBHOOK_SECRET` is set. |

---

## Events — `/api/events/*`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/events/counts` | 🔒 | Server-Sent Events stream of `{inbox, in_flight, trash}` counts (unnamed `data:` events). Polls Paperless every 3s server-side; emits on connect, on every change, and at least every 25s as a heartbeat so nginx does not reap the connection. Emits `event: error` / `data: paperless_auth` when the Paperless token is rejected. Drives every Nav badge. |

---

## Type-specific fields

These endpoints serve the SPA's "Typenspezifische Felder" section
(invoice number, IBAN, payslip months, etc.). The values live in the
`aktenraum` database, not Paperless.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/document-types/schema` | 🔒 | The full `TYPE_FIELD_SCHEMA` for all 27 doc types (`Cache-Control: private, max-age=3600`). The SPA caches this and renders inputs based on the field's `kind` (`string`, `date`, `month`, `year`, `money`). |
| GET | `/api/documents/{id}/type-fields` | 🔒 | Current values for one doc — `{document_type, fields: {name: value}}`. 404 when none are stored. |
| PATCH | `/api/documents/{id}/type-fields` | 🔒 or secret | Body `{fields, document_type?}`. Upserts the values. Accepts either the session cookie or `X-Aktenraum-Secret` (the auto-tagger writes extracted type fields through this route). Unknown field names → 422. |

---

## Shape references

Definitive types live alongside the controllers:

| Schema | File |
|---|---|
| `SearchFilter` / `DocumentSummary` / `AskRequest` / `AskResponse` / `AnswerRequest` / `AnswerResponse` | [`services/aktenraum-api/src/ai/ai.schemas.ts`](../services/aktenraum-api/src/ai/ai.schemas.ts) |
| `LoginRequest` / `ChangePasswordRequest` / `UserResponse` | [`services/aktenraum-api/src/auth/auth.schemas.ts`](../services/aktenraum-api/src/auth/auth.schemas.ts) |
| `InboxItem` / `InboxDetail` / `InboxFieldUpdate` / `InboxList` | [`services/aktenraum-api/src/inbox/inbox.schemas.ts`](../services/aktenraum-api/src/inbox/inbox.schemas.ts) |
| `LibraryItem` / `LibraryList` / `TagFacet` / `TagFacetList` | [`services/aktenraum-api/src/library/library.schemas.ts`](../services/aktenraum-api/src/library/library.schemas.ts) |
| `TrashItem` / `TrashList` / `EmptyTrashResponse` | [`services/aktenraum-api/src/trash/trash.schemas.ts`](../services/aktenraum-api/src/trash/trash.schemas.ts) |
| `LLMSettings` / `AvailableModelsResponse` / `ActiveModelResponse` / `AutoApproveRule` | [`services/aktenraum-api/src/settings/settings.schemas.ts`](../services/aktenraum-api/src/settings/settings.schemas.ts) |
| `ReprocessResponse` / `DocIdResponse` / `InFlightCount` / `ProcessingStateResponse` / `TaskStatusResponse` / `DocumentStatusResponse` | [`services/aktenraum-api/src/documents/documents.service.ts`](../services/aktenraum-api/src/documents/documents.service.ts) |
| `UploadResult` / `UploadResponse` | [`services/aktenraum-api/src/upload/upload.service.ts`](../services/aktenraum-api/src/upload/upload.service.ts) |
| `TypeFieldsResponse` | [`services/aktenraum-api/src/type-fields/type-fields.controller.ts`](../services/aktenraum-api/src/type-fields/type-fields.controller.ts) |
| `DocumentType` enum, `DocumentExtraction` | [`packages/aktenraum-core/src/models/extraction.ts`](../packages/aktenraum-core/src/models/extraction.ts) |
| `TYPE_FIELD_SCHEMA` map | [`packages/aktenraum-core/src/models/typeSchema.ts`](../packages/aktenraum-core/src/models/typeSchema.ts) |

---

## Auto-tagger internal endpoints

Not part of the public API. The auto-tagger runs a small `node:http`
listener on internal port 8001 (`services/auto-tagger/src/webhook.ts`),
reachable only from inside the compose network.

| Method | Path | Purpose |
|---|---|---|
| POST | `/trigger/extract` | Body `{document_id}`. Enqueues extraction. Called by Paperless's `post_consume_script` and by `aktenraum-api` reprocess. |
| POST | `/trigger/propagate` | Enqueues propagation. Called by `aktenraum-api` after approve. |
| POST | `/trigger/reindex-metadata` | Refreshes a doc's Qdrant payload metadata (no re-embed). Called after star/unstar. |
| GET | `/processing` | Current extraction / propagation / indexer slot occupants; backs `/api/documents/processing`. |
| GET | `/health` | Liveness. |

```bash
# From a container inside the network
curl -sS -X POST \
  -H "Content-Type: application/json" \
  -H "X-Aktenraum-Secret: $WEBHOOK_SECRET" \
  -d '{"document_id": 27}' \
  http://auto-tagger:8001/trigger/extract
```

When `WEBHOOK_SECRET` is empty, the `X-Aktenraum-Secret` header is
not required. Successful triggers return `{queued, trigger}`.
