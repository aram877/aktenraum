# API reference

`aktenraum-api` (FastAPI on port 8002 inside the network) is the only
service the SPA talks to. nginx reverse-proxies `/api/*` to it. All
routes are mounted under `/api`.

The auth model is a single HS256 JWT in an httpOnly `SameSite=Lax`
cookie set by `/api/auth/login`. The SPA never sees the token; the
cookie travels automatically. Endpoints marked **🔒** require a valid
cookie; unauthenticated calls return 401.

OpenAPI is available at `/api/openapi.json` (and Swagger UI at
`/api/docs` when not running in production mode). The SPA's TypeScript
types are regenerated from this with `pnpm --filter @aktenraum/web
generate:api-types`. **Treat this doc as a map; the OpenAPI schema is
the source of truth for shape.**

---

## Health

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | — | Liveness probe. Returns `{"status": "ok"}`. |

---

## Auth — `/api/auth/*`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | — | Body `{username, password}`. Sets the session cookie. Returns `UserResponse`. |
| POST | `/api/auth/logout` | — | Clears the session cookie. 204 No Content. |
| GET  | `/api/auth/me` | 🔒 | Returns the current `UserResponse`. The SPA's router uses this to decide whether to redirect to `/login`. |

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
  document_type?: DocumentType         // one of the 26 enum values
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
data: {"filter": {...}, "total": 5, "candidate_ids": [12, 17, ...]}

event: chunk
data: {"delta": "Die letzte "}

event: chunk
data: {"delta": "Rechnung..."}

event: final
data: {"answer_de": "...", "citations": [...]}
```

When `QDRANT_URL` is set, the prompt to the answer model includes the
top-5 reranked chunks from Qdrant per candidate doc; the answer is
expected to include `[Quelle: <id>]` markers inline, which are
extracted post-hoc and intersected with the retrieved set.

When `QDRANT_URL` is unset (or any RAG stage errors), the pipeline
degrades gracefully to the AI-metadata-only path.

`bge-reranker-v2-m3` is lazy-loaded — the first `/ask` after a fresh
container blocks ~5 minutes downloading the model from HuggingFace.

---

## Documents — `/api/documents/*`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/documents/upload` | 🔒 | Multipart `files` (one or many). Streams each through to Paperless's `/api/documents/post_document/`. Per-file failure is isolated. Returns `{results: [{filename, status, task_id, detail}]}`. |
| POST | `/api/documents/{id}/reprocess` | 🔒 | Clears every lifecycle tag and pings the auto-tagger webhook. Falls back to the 30s poller if the webhook is unreachable. |
| GET  | `/api/documents/{id}/detail` | 🔒 | Full review payload (same shape as `/api/inbox/{id}`) — works on any doc, not just `ai-pending`. |
| PATCH | `/api/documents/{id}/fields` | 🔒 | Partial update of the 10 AI fields. Body `InboxFieldUpdate`. |
| GET  | `/api/documents/in-flight` | 🔒 | `{count: number}` — docs carrying `ai-pending` or `ai-approved`. The Nav badge polls this every 30s. |
| GET  | `/api/documents/task/{uuid}` | 🔒 | Proxies Paperless's task lookup. `{task_id, status, doc_id?, result?}`. `doc_id` is regex-fallback parsed from the result string for older Paperless versions. |
| GET  | `/api/documents/{id}/status` | 🔒 | Lightweight `{id, lifecycle_tags}` lookup used by the upload-page poller. |
| GET  | `/api/documents/{id}/preview` | 🔒 | Inline PDF stream (`Content-Type: application/pdf`, `Cache-Control: private, max-age=300`). |
| GET  | `/api/documents/{id}/download` | 🔒 | Original file with upstream `Content-Disposition` forwarded. |
| DELETE | `/api/documents/{id}` | 🔒 | 204 No Content. Invalidates the SPA's library + inbox caches. |

---

## Inbox — `/api/inbox/*` (review queue)

Specialised endpoints for `ai-pending` documents. The `/library?tab=review`
view in the SPA uses these.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET  | `/api/inbox/` | 🔒 | Paginated list of `ai-pending` docs. Query: `page`, `page_size`, `ordering`. |
| GET  | `/api/inbox/{id}` | 🔒 | Full review payload (12 `ai_*` fields + content excerpt + tags). |
| PATCH | `/api/inbox/{id}` | 🔒 | Partial field update (`InboxFieldUpdate`). |
| POST | `/api/inbox/{id}/approve` | 🔒 | Optional body to patch fields in the same call. Tag swap `ai-pending` → `ai-approved`. Idempotent re-approve is a no-op. |
| POST | `/api/inbox/{id}/reject` | 🔒 | Tag swap `ai-pending` → `ai-rejected`. |
| GET  | `/api/inbox/{id}/preview` | 🔒 | Same PDF stream as `/api/documents/{id}/preview`. |

Tag swaps are planned by `_plan_tag_swap` (pure helper) so the patch
body always contains the full `tags=[…]` array — Paperless's PATCH is
full-replace, not partial. The custom-fields PATCH has the same
gotcha and is handled by `_merge_custom_fields`.

---

## Library — `/api/library/*` (archive view)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/library/` | 🔒 | Paginated list of non-pending docs. Server-side excludes `ai-pending`. |
| GET | `/api/library/tags` | 🔒 | Tag facet — `{name, count}` over the current corpus, used for the tag chip cloud. |

`GET /api/library/` query params:

| Param | Type | Notes |
|---|---|---|
| `document_type` | enum | One of the 26 `DocumentType` values. |
| `correspondent` | string | Exact match against Paperless. |
| `date_from` / `date_to` | date | ISO YYYY-MM-DD. |
| `text` | string | Full-text content search. |
| `tags` | string[] | AND semantics. |
| `page` | int ≥ 1 | |
| `page_size` | int 1..100 | |
| `ordering` | enum | `-created`, `created`, `-modified`, `modified`, `title`, `-title`. Unsafe values rejected with 422. |

Returns `{results: LibraryItem[], total, page, page_size}`. `LibraryItem`
carries `lifecycle_tags` (small badge per tag — propagated / approved /
rejected / error) and falls back to AI custom fields when the native
correspondent / doc_type FK is unset.

---

## Type-specific fields (pass 2)

These endpoints serve the SPA's "Typenspezifische Felder" section
(invoice number, IBAN, payslip months, etc.). The values live in the
`aktenraum` database, not Paperless.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/document-types/schema` | 🔒 | The full `TYPE_FIELD_SCHEMA` for all 26 doc types. The SPA caches this and renders inputs based on the field's `kind` (`string`, `date`, `month`, `year`, `money`). |
| GET | `/api/documents/{id}/type-fields` | 🔒 | Current values for one doc — `{document_type, fields: {name: value}}`. |
| PATCH | `/api/documents/{id}/type-fields` | 🔒 | Partial update. Unknown field names → 422. |

---

## Shape references

Definitive types live alongside the routers:

| Schema | File |
|---|---|
| `SearchFilter` / `DocumentSummary` / `AskResponse` / `AnswerResponse` | [`services/aktenraum-api/src/aktenraum_api/ai/schemas.py`](../services/aktenraum-api/src/aktenraum_api/ai/schemas.py) |
| `InboxItem` / `InboxDetail` / `InboxFieldUpdate` / `InboxList` | [`services/aktenraum-api/src/aktenraum_api/inbox/schemas.py`](../services/aktenraum-api/src/aktenraum_api/inbox/schemas.py) |
| `LibraryItem` / `LibraryList` / `TagFacet` / `TagFacetList` | [`services/aktenraum-api/src/aktenraum_api/library/schemas.py`](../services/aktenraum-api/src/aktenraum_api/library/schemas.py) |
| `UploadResponse` / `ReprocessResponse` / `InFlightCount` / `TaskStatus` / `DocumentStatus` | [`services/aktenraum-api/src/aktenraum_api/documents/`](../services/aktenraum-api/src/aktenraum_api/documents/) |
| `TypeFieldsResponse` | [`services/aktenraum-api/src/aktenraum_api/type_fields/`](../services/aktenraum-api/src/aktenraum_api/type_fields/) |
| `DocumentType` enum, `DocumentExtraction` | [`packages/aktenraum-core/src/aktenraum_core/models/extraction.py`](../packages/aktenraum-core/src/aktenraum_core/models/extraction.py) |
| `TYPE_FIELD_SCHEMA` map | [`packages/aktenraum-core/src/aktenraum_core/models/type_schema.py`](../packages/aktenraum-core/src/aktenraum_core/models/type_schema.py) |

---

## Auto-tagger internal endpoint

Not part of the public API, but worth mentioning: the auto-tagger
exposes `POST /trigger/extract` on internal port 8001. It's only
reachable from inside the compose network and is called by Paperless's
`post_consume_script` and by `aktenraum-api` for the reprocess flow.

```bash
# From a container inside the network
curl -sS -X POST \
  -H "Content-Type: application/json" \
  -H "X-Aktenraum-Secret: $WEBHOOK_SECRET" \
  -d '{"document_id": 27}' \
  http://auto-tagger:8001/trigger/extract
```

When `WEBHOOK_SECRET` is empty, the `X-Aktenraum-Secret` header is
not required.

The auto-tagger also exposes `/health` on the same port for liveness.
