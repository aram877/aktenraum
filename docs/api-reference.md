# API reference

`aktenraum-api` (NestJS on port 8002 inside the network) is the only
service the SPA talks to. nginx reverse-proxies `/api/*` to it. All
routes are mounted under the global prefix `/api` (`app.setGlobalPrefix("api")`
in `services/aktenraum-api/src/main.ts`). Errors use the `{detail}` shape.

The auth model is a server-side session (`sessions` table) whose opaque
random token travels in an httpOnly `SameSite=Lax` cookie set by
`/api/auth/login` — `aktenraum_session` on plain-HTTP localhost,
`__Host-aktenraum_session` (`Secure`) when `COOKIE_SECURE=true`. The
server stores only the token's SHA-256 hash. The SPA never sees the
token; the cookie travels automatically. Sessions expire after 7 days
without use or 30 days after login, and are revocable. Endpoints marked **🔒** require a valid
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
| GET | `/api/health/backup` | session | Backup health from the backup container's status file: `{state: ok\|stale\|failing\|unknown, last_backup_at, age_hours, max_age_hours, checked_at, last_run_at, last_run_exit, detail}`. `unknown` = no status file (backup service not deployed). `failing` also when the container hasn't reported for > 3 h. |

---

## Auth — `/api/auth/*`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | — | Body `{username, password}`. Only for members without a passkey: creates a **restricted** session (enrolment only) and returns `{username, enrolment_required: true}`. 401 `Invalid credentials` — the same answer for unknown users, removed members and members whose password is retired (any passkey enrolled). 429 + `Retry-After` after 10 failures in 15 min for the username **or** the client address (persisted in Postgres, survives restarts); success resets only the username's count. |
| GET | `/api/auth/webauthn` | — | `{origins}` — where passkeys work (`WEBAUTHN_ORIGINS`); the login page compares it with its own origin. |
| POST | `/api/auth/passkeys/login/begin` | — | Discoverable sign-in: `{ceremony, options}` (WebAuthn request options, UV required, 5 min). 400 when `Origin` is not configured; 429 when the address is throttled. |
| POST | `/api/auth/passkeys/login/finish` | — | Body `{ceremony, response}` → `{username}` + a `passkey` session cookie with a fresh step-up. Every failure (unknown / removed passkey, removed member, wrong user handle, counter regression, replayed or expired ceremony, bad signature) → the same 401 `Passkey nicht akzeptiert`, counted on `login:ip:<address>` and audited (`login_failed`, reason `passkey`). |
| POST | `/api/auth/passkeys/register/begin` | 🔒 restricted ok | Body `{}`. Restricted session → `enrol` ceremony (no step-up); full session → `add` ceremony (step-up). `excludeCredentials` = the caller's passkeys on this RP ID. |
| POST | `/api/auth/passkeys/register/finish` | 🔒 restricted ok | Body `{ceremony, response, name?}` → `{passkey, recovery_codes}`. Enrol: stores the passkey, creates 10 recovery codes when none is unused (shown once, else `null`), retires the password, revokes the member's `password` sessions (`password_change`) and the enrolling recovery session (`user`), and sets a **new** `passkey` session cookie. Add: stores it, `recovery_codes: null`. 409 duplicate credential. |
| GET | `/api/auth/passkeys` | 🔒 | `[{id, name, provider, synced, rp_id, created_at, last_used_at, prf}]` — own active passkeys. `provider` from the AAGUID ("Passkey" when unknown); `synced` = multi-device. |
| PATCH | `/api/auth/passkeys/:id` | 🔒 step-up | Body `{name}` (1–64) → the passkey. 404 for another member's or unknown. |
| DELETE | `/api/auth/passkeys/:id` | 🔒 step-up | 204. 409 for the last active passkey; 404 for another member's. Sessions stay (use the device list). |
| POST | `/api/auth/step-up/begin` | 🔒 | `{ceremony, options}` with `allowCredentials` = the caller's passkeys on this RP ID; 409 when there is none here. |
| POST | `/api/auth/step-up/finish` | 🔒 | Body `{ceremony, response}` → 204 and `step_up_at = now()` on the session (valid 5 min). Another member's passkey, no UV, a replay → 401, counted on `login:ip`, audited `step_up_failed`. |
| POST | `/api/auth/recovery` | — | Body `{username, code}` (case, spaces, dashes, O/0, I/L/1 forgiven). One unused code → `{username, enrolment_required: true}` + a restricted `recovery` session; the code is used up. Wrong code or unknown name → the same 401; limits `login:user` + `login:ip`. |
| GET | `/api/auth/recovery-codes` | 🔒 | `{remaining}` unused codes. |
| POST | `/api/auth/recovery-codes` | 🔒 step-up | A new set `{codes}` (10, shown once); the old unused codes stop working. |
| POST | `/api/auth/logout` | — | Revokes the current session on the server (a copied cookie stops working) and clears the cookie. Unknown/expired cookie = no-op. 204 No Content. |
| GET  | `/api/auth/me` | 🔒 | Returns the current `UserResponse`. The SPA's router uses this to decide whether to redirect to `/login`. |
| GET  | `/api/auth/sessions` | 🔒 | The caller's active sessions, most recently used first: `[{id, created_at, last_seen_at, auth_method, ip, user_agent, current}]`. `ip` / `user_agent` are those of the login. |
| DELETE | `/api/auth/sessions/:id` | 🔒 | Revokes one of the caller's own sessions (204). Another member's, unknown or already ended → 404. Revoking the current one behaves like logout (cookie cleared). |
| POST | `/api/auth/sessions/revoke-others` | 🔒 | Revokes every active session of the caller except the current one. Returns `{revoked: n}`. |

`POST /api/auth/change-password` is gone (auth-passkeys) — there is no password to change.

**Restricted sessions.** A session started with a password or a recovery code, or of a member without an active passkey, may call only `GET /auth/me`, `POST /auth/passkeys/register/begin|finish` (and the unguarded logout). Every other guarded route answers **403 `{"detail": "enrolment_required"}`** — deny by default (`@AllowRestricted()` marks the three; `test/route-inventory.test.ts` pins them). The live-counts stream is refused too.

**Step-up.** Routes marked "step-up" answer **403 `{"detail": "step_up_required"}`** unless the session has a passkey confirmation from the last 5 minutes (a passkey / setup / invite sign-in counts): passkey rename / remove / add, `POST /auth/recovery-codes`, `POST|DELETE /household/invites*`, `POST /household/members/:id/setup-link`, `POST /household/members/:id/remove`, `DELETE /spaces/:id`, `POST|PATCH|DELETE /spaces/:id/members*`, `POST /trash/empty`, `POST /trash/:doc_id/delete`, `PATCH /settings/llm`, `PATCH /settings/answer-llm`, `PUT /settings/auto-approve`. The SPA's `useApi` runs the step-up ceremony and repeats the request once.

The client address is the browser's: the api trusts exactly one proxy hop (nginx, `trust proxy` = 1). Authentication events (login succeeded/failed/throttled — `reason` = `passkey` / `recovery` for those methods —, logout, session revoked with actor + reason, invite redeemed) are written to `auth_audit`; credential events (passkey added/renamed/removed, recovery codes generated/used, setup link created/used, password retired, step-up succeeded/failed) to `credential_audit`; both 180 days, no route yet.

`UserResponse`: `{username, household_role?, enrolment_required?, auth_method?}` (the last three on `/me`).

---

## Household — `/api/household/*` and `/api/invites/*`

Household admin only (`household:admin`), session cookie:

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/household/members` | `[{id, username, role: "admin"\|"member", joined_at}]` |
| GET | `/api/household/invites` | pending invites `[{id, created_at, expires_at}]` |
| POST | `/api/household/invites` | `201 {id, token, expires_at}` — the token is shown only here; the SPA turns it into `<origin>/invite/<token>` |
| DELETE | `/api/household/invites/{id}` | `204`; `404` when not pending |
| POST | `/api/household/members/{id}/setup-link` | step-up. `201 {id, token, expires_at}` — a single-use setup link (30 min) for any non-removed member, the admin included; earlier unused links of that member are revoked. The SPA turns the token into `<origin>/setup/<token>`. `404` unknown or removed member |
| GET | `/api/household/members/{id}/removal-preview?successor={member_id}` | what removing `{id}` would do, changes nothing: `{member_id, username, successor_member_id, successor, documents, trashed, spaces_owned: [{id, name}], spaces_left: [{id, name}], shares_revoked, shares_kept}`. `successor` defaults to the admin. `documents` = personal-space documents (trashed ones included), `trashed` = of those in the Paperless trash (`null` when Paperless couldn't be asked). Same errors as the removal, minus the confirmation |
| POST | `/api/household/members/{id}/remove` | body `{confirm_username, successor_member_id?}` → `200 {member_id, successor_member_id, status: "done"\|"completing"}`. `completing` = locked out and database changes done, Paperless/Qdrant still catching up (the sync retries every 5 min). `404` unknown or already removed, `409` the admin / yourself, `422` username mismatch or invalid successor (removed, unknown, the member itself). Irreversible |
| GET | `/api/household/removals` | `[{member_id, username, successor, removed_at, status: "done"\|"completing", last_error}]`, oldest first |

Removed members (`tenancy-member-removal`) disappear from `/members`, `/directory` and every picker, count no longer in `household_member_count`, and are refused as space member (`404`) and share recipient (`422`). All their sessions are revoked (`401`, open streams end with `session_ended`), their login answers like a wrong password (and counts towards the throttle), and their username stays taken (`409` on redeem).

Public (no session; throttled per client address in Postgres, 10 failures / 15 min → `429` + `Retry-After`; joining creates a session with `auth_method = invite` and a fresh step-up):

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/invites/{token}` | `{expires_at}`; **every** invalid state (unknown, expired, revoked, used) → `404 {"detail": "Einladung ungültig oder abgelaufen"}` |
| POST | `/api/invites/{token}/register/begin` | body `{username (3–64, letters/digits/._-)}` → `{ceremony, options}`; `409` username taken, `404` as above (counted). Nothing is claimed yet |
| POST | `/api/invites/{token}/register/finish` | body `{ceremony, response}` → `200 {username, recovery_codes}` + session cookie: a passwordless member (`password_hash = '!'`, password retired) with the passkey and 10 recovery codes. A failed or cancelled ceremony leaves the invite pending |

`/redeem` (username + password) is gone (auth-passkeys).

Setup links (public, same throttle shape on `setup:ip:<address>`; every invalid state — unknown, expired, used, revoked, member removed — is the same `404 {"detail": "Einrichtungslink ungültig oder abgelaufen"}`):

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/setup/{token}` | `{username, expires_at}` |
| POST | `/api/setup/{token}/register/begin` | `{ceremony, options}` |
| POST | `/api/setup/{token}/register/finish` | body `{ceremony, response}` → `200 {username, recovery_codes}` + a full `setup` session; the link is used up only after a verified ceremony; a new recovery set replaces the old one; other sessions stay. Also issued on the host: `task setup-link USER=<name>` (`node dist/auth/setup-link-cli.js <name>` in the api container) |

Any member (`spaces:manage`): `GET /api/household/directory` → `[{id, username}]` — member ids for the space member picker, nothing else.

## Spaces ("Akten") — `/api/spaces/*`

Every member (`spaces:manage`). A space the caller isn't in answers `404`; personal spaces refuse rename, delete and membership edits with `409`; owner-only actions by an editor/viewer answer `403`. Paperless failures during a membership change are undone and answer `502`.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/spaces` | `{household_member_count, spaces: [{id, name, kind: "personal"\|"shared", role: "owner"\|"editor"\|"viewer", owner, member_count, document_count}]}` — the caller's spaces |
| POST | `/api/spaces` | body `{name (1–128)}` → `201` space; the caller is its only owner; `409` when a shared space of that name already exists among the caller's |
| PATCH | `/api/spaces/{id}` | `{name}` → `204` (owner) |
| DELETE | `/api/spaces/{id}` | `204` (owner); `409` while any document — trashed ones included — still has it as home space |
| GET | `/api/spaces/{id}/members` | `[{member_id, username, role}]` (any member of the space) |
| POST | `/api/spaces/{id}/members` | `{member_id, role: "editor"\|"viewer"}` → `201` (owner); `409` already a member; `404` unknown member |
| PATCH | `/api/spaces/{id}/members/{member_id}` | `{role}` → `200` (owner); the owner's own role → `409` |
| DELETE | `/api/spaces/{id}/members/{member_id}` | `204` — the owner removes someone, or a non-owner removes themselves (leave); the owner can't leave (`409`) |
| POST | `/api/spaces/{id}/documents` | bulk move into the space: `{doc_ids: [1..200 ids]}` → `200 {results: [{doc_id, status: "moved"\|"unchanged"\|"forbidden"\|"not_found"\|"failed", detail?}]}`; a document the caller can't read is `not_found` |

`POST /api/documents/{doc_id}/move` `{space_id}` → `200 {doc_id, status: "moved"|"unchanged"}`. Needs `owner` of the document's current space (`403` otherwise; `404` when the caller can't read it) and `owner`/`editor` of the target (`403` for a viewer, `404` for a space the caller isn't in). A move rewrites the home space, the Paperless owner + permissions and the Qdrant `space_id` together; any failure restores the original space and answers `502`.

## Shares — per-document (`tenancy-document-shares`)

Every member (`shares:manage`). The per-document routes need `owner` of the document's home space; anyone else (space editors/viewers, recipients, outsiders) gets `404`. Grant, change and revoke update the DB, the Paperless permissions and the Qdrant `shared_with` together; a failure is undone and answers `502`. Expired shares count as absent everywhere.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/documents/{doc_id}/shares` | `[{member_id, username, role: "viewer"\|"editor", expires_at, granted_at, granted_by}]` — active shares |
| POST | `/api/documents/{doc_id}/shares` | `{member_id, role, expires_at? (ISO with offset)}` → `201` share. `409` existing share or member of the home space; `422` self, unknown member, past expiry |
| PATCH | `/api/documents/{doc_id}/shares/{member_id}` | `{role?, expires_at?}` (`expires_at: null` clears it; at least one field) → `200` share; `404` no active share |
| DELETE | `/api/documents/{doc_id}/shares/{member_id}` | `204`; access ends at once (aktenraum, Paperless, Ask) |
| GET | `/api/documents/{doc_id}/shares/audit` | `[{id, member_id, member, actor, event, access_kind, at}]`, newest first, ≤ 500. Events `granted`, `role_changed`, `expiry_changed`, `revoked`, `expired` (actor null), `accessed` (kind `detail`/`preview`/`download`/`ask`, ≤ 1 per kind and hour) |
| GET | `/api/shares/with-me` | `[{doc_id, title, shared_by, role, expires_at}]` — trashed documents left out |
| GET | `/api/shares/by-me` | `[{doc_id, title, member: {id, username}, role, expires_at, granted_at}]` — shares on documents whose home space the caller owns (follows a move) |

A `viewer` share reads, previews, downloads and finds the document in Ask; an `editor` share may also `PATCH /fields` and `PATCH /type-fields`. Approve, reject, reprocess, star, dismiss-duplicate, move, delete and sharing are refused (`404`, move `403`).

**Member scoping**: every member-facing endpoint below reaches Paperless with the calling member's own Paperless token, so lists, counts and by-id access only cover documents that member may see; another member's document answers `404`. Exceptions: worker-only internal routes, and `/api/ingest/activity` for the household admin (household-wide imports).

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
| POST | `/api/documents/upload` | 🔒 | Multipart `files` (one or many), optional `space_id` (target space — `owner`/`editor` only, else `403` before anything reaches Paperless; absent = personal space). Streams each through to Paperless's `/api/documents/post_document/`. Per-file failure is isolated. Returns `{results: [{filename, status, task_id, detail}]}`. |
| POST | `/api/documents/reprocess-failed` | 🔒 | Reprocesses every document in the error state (same semantics as single reprocess), sequentially, up to 200 per call. Per-document failures are collected, not fatal. Returns `{requested, reprocessed, failed: [{doc_id, detail}], remaining}`. |
| POST | `/api/documents/{id}/reprocess` | 🔒 | Clears every lifecycle tag and pings the auto-tagger webhook. Falls back to the 30s poller if the webhook is unreachable. Returns `ReprocessResponse`. |
| GET  | `/api/documents/{id}/detail` | 🔒 | Full review payload (same shape as `/api/inbox/{id}`) — works on any doc, not just `ai-pending`. Carries `home_space`, `access: {via: "space"\|"share"\|"admin", role}` and, for a document reached through a share, `home_space: null` + `shared_by: {username, role, expires_at}`. |
| PATCH | `/api/documents/{id}/fields` | 🔒 | Partial update of the 12 AI fields. Body `InboxFieldUpdate`. Action `edit-fields`: space owner/editor or an editor share. |
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
| GET  | `/api/inbox/` | 🔒 | Paginated list of `ai-pending` docs — only from spaces where the caller is `owner` or `editor` (viewers see pending documents in the library only, documents shared with the caller never appear; the live-counts inbox number follows the same rule). Query: `page`, `page_size` (default 20, max 100), `ordering` (allowlisted, default `-modified`; unknown values fall back to the default). |
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
| GET | `/api/library/tags` | 🔒 | Tag facet — `{name, count}` over the current corpus, used for the tag chip cloud. Pipeline markers (`ai-*`, incl. `ai-duplicate` / `ai-duplicate-dismissed` / `ai-index-error`) are excluded. |
| GET | `/api/library/types` | 🔒 | Document-type facet — `{results: [{name, count}]}` from Paperless `document_count`, largest first, empty types omitted. Counts match `?document_type=` results. |

`GET /api/library/` query params:

| Param | Type | Notes |
|---|---|---|
| `document_type` | enum | One of the 27 `DocumentType` values. |
| `correspondent` | string | Exact match against Paperless. |
| `date_from` / `date_to` | date | ISO YYYY-MM-DD. |
| `text` | string | Full-text content search. |
| `tags` | string[] | AND semantics. |
| `space` | int | Home space id; only the caller's spaces (`403` otherwise). Sent to Paperless as `id__in`; above 1,000 ids the api queries in chunks and merges. Disables the page-1 in-flight pin. |
| `status` | enum | Processing state: `error` (any of `ai-error` / `ai-propagation-error` / `ai-index-error`), `unprocessed` (no lifecycle tag), `approved`, `done` (`ai-propagated`), `rejected`. Other values → 422. A status whose tag does not exist yet returns an empty page. Disables the page-1 in-flight pin. |
| `page` | int ≥ 1 | |
| `page_size` | int 1..100 | Default 25. |
| `ordering` | enum | `-created` (default), `created`, `-modified`, `modified`, `title`, `-title`. Other values rejected with 422. |

Returns `{results: LibraryItem[], total, page, page_size}`. `LibraryItem`
carries `lifecycle_tags` (small badge per tag — propagated / approved /
rejected / error), `home_space {id, name, kind}` (null while unassigned, or when the caller reaches the document only through a share) and `shared_by {username, role, expires_at}` (shared documents; null otherwise), and falls back to AI custom fields when the native
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
short TTL cache, authenticated with the worker's service credential
(`Authorization: Bearer <SVC_TOKEN_WORKER>`, ADR-010 step 5). A missing or
non-worker credential is 401 (`Invalid credential`); the endpoints never accept
a session cookie.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET  | `/api/settings/llm` | 🔒 | Active extraction model. `{model}` — a literal Ollama tag stored in `app_settings.llm_model`. |
| PATCH | `/api/settings/llm` | 🔒 | Body `{model}` (non-empty, max 128 chars). Sets the extraction model. |
| GET  | `/api/settings/answer-llm` | 🔒 | Active answer model for `/api/ai/answer*`. `{model}` (`app_settings.answer_llm_model`). |
| PATCH | `/api/settings/answer-llm` | 🔒 | Body `{model}`. Sets the answer model. |
| GET  | `/api/settings/available-models` | 🔒 | `{models: string[]}` — the tags currently pulled in Ollama (`GET /api/tags` on `OLLAMA_BASE_URL`). Empty list when `LLM_BACKEND` is not `ollama` or Ollama is unreachable; the SPA then shows a free-text input. |
| GET  | `/api/settings/active-llm-model` | worker | Internal: auto-tagger reads the active extraction model. Returns `{ollama_model}`. Worker credential only (in-network). |
| GET  | `/api/settings/auto-approve` | 🔒 | `{rules: AutoApproveRule[]}` — per-`DocumentType` `enabled`, `min_confidence`, `updated_at`, `updated_by`. One row per enum value. |
| PUT  | `/api/settings/auto-approve` | 🔒 | Body `{rules: [{document_type, enabled, min_confidence}]}`. Replaces the rule set (transactional). Unknown or duplicate types are rejected. |
| GET  | `/api/settings/active-auto-approve-rules` | worker | Internal: auto-tagger reads the rules every 60s (TTL cache). Worker credential only (in-network). |

---

## Events — `/api/events/*`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/events/counts` | 🔒 | Server-Sent Events stream of `{inbox, in_flight, trash, errors}` counts (`errors` = docs carrying any error tag) (unnamed `data:` events). Polls Paperless every 3s server-side; emits on connect, on every change, and at least every 25s as a heartbeat so nginx does not reap the connection. Emits `event: error` / `data: paperless_auth` when the Paperless token is rejected. Re-checks the session every tick and ends with `event: session_ended` / `data: revoked` or `data: expired` when it was revoked (logout, other device, password change, member removal) or expired; the SPA stops reconnecting on it. Drives every Nav badge. |

---

## Import activity — `/api/ingest/*`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/ingest/activity?days=N` | 🔒 | What Paperless imported in the last `N` days (1–30, default 7; out-of-range values are clamped). Read-through over Paperless `/api/tasks/?task_name=consume_file` and `/api/processed_mail/`; no aktenraum storage except `upload_tasks`. 502 when Paperless fails. |

Response: `{days, items, mails, summary, truncated}`.

- `items[]` (newest first, max 500 → `truncated`): `{task_id, file_name, created, done, source, outcome, document, duplicate_of, message}`.
  - `source`: `upload` (task id recorded in `upload_tasks` by the upload endpoint), `folder` (task has no owner — consume folder), else `email` (mail-rule owner).
  - `outcome`: `new` (SUCCESS → `document`), `duplicate` (Paperless "It is a duplicate of … (#N)" → `duplicate_of`), `failed` (other FAILURE → `message`, filename prefix stripped), `running`.
  - `document` / `duplicate_of`: `{id, title, lifecycle_tags, missing}`, resolved live via `id__in` so the badge reflects the current pipeline state; `missing` = trashed or deleted.
- `mails[]`: `{id, subject, received, processed, status, error_summary}` — `error_summary` is the last line of Paperless's Celery traceback. A mail is `FAILED` as soon as one attachment fails, including a duplicate.
- `summary`: `{new, duplicate, failed, running, by_source: {email, upload, folder}}`.

---

## Type-specific fields

These endpoints serve the SPA's "Typenspezifische Felder" section
(invoice number, IBAN, payslip months, etc.). The values live in the
`aktenraum` database, not Paperless.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/document-types/schema` | 🔒 | The full `TYPE_FIELD_SCHEMA` for all 27 doc types (`Cache-Control: private, max-age=3600`). The SPA caches this and renders inputs based on the field's `kind` (`string`, `date`, `month`, `year`, `money`). |
| GET | `/api/documents/{id}/type-fields` | 🔒 | Current values for one doc — `{document_type, fields: {name: value}}`. 404 when none are stored. |
| PATCH | `/api/documents/{id}/type-fields` | 🔒 or worker | Body `{fields, document_type?}`. Upserts the values. Accepts either the session cookie or the worker credential (the auto-tagger writes extracted type fields through this route). A request with an `Authorization` header is judged by it alone: anything but the worker credential is 401 `Invalid credential`, never a fallback to the cookie. Unknown field names → 422. |

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

Every route except `/health` needs a service credential as
`Authorization: Bearer <token>` (ADR-010 step 5, `service-credentials`). Each
caller may use only its own routes:

| Method | Path | Allowed callers | Purpose |
|---|---|---|---|
| POST | `/trigger/extract` | `paperless-hook`, `api` | Body `{document_id}`. Enqueues extraction. Called by Paperless's `post_consume_script` (`SVC_TOKEN_PAPERLESS_HOOK`) and by `aktenraum-api` reprocess (`SVC_TOKEN_API`). |
| POST | `/trigger/propagate` | `api` | Enqueues propagation. Called by `aktenraum-api` after approve. |
| POST | `/trigger/reindex-metadata` | `api` | Refreshes a doc's Qdrant payload metadata (no re-embed). Called after star/unstar. |
| GET | `/processing` | `api` | Current extraction / propagation / indexer slot occupants; backs `/api/documents/processing`. |
| GET | `/health` | anyone | Liveness. |

An unknown or missing credential is **401** (`webhook_rejected
reason=unknown_credential`); a known caller outside its row — e.g. the hook on
`/trigger/propagate`, or the worker's own credential on any route — is **403**
(`webhook_rejected reason=not_allowed caller=… route=…`). Accepted triggers log
`webhook_enqueued` with `caller`. The old `X-Aktenraum-Secret` header is not
accepted.

```bash
# From the paperless container (it holds the hook token as AKTENRAUM_HOOK_TOKEN)
docker compose --project-directory docker exec paperless sh -c \
  'curl -sS -X POST -H "Content-Type: application/json" \
     -H "Authorization: Bearer $AKTENRAUM_HOOK_TOKEN" \
     -d "{\"document_id\": 27}" http://auto-tagger:8001/trigger/extract'
```

When a credential is empty, every call that needs it is rejected (fail-closed).
Successful triggers return `{queued, trigger}`.
