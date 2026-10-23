## Context

Processing state lives entirely in Paperless tags (`ai-*` lifecycle + auxiliary tags). Import outcome lives in two Paperless tables aktenraum never reads: `/api/tasks/` (one row per consume attempt, unpaginated list, carries `task_file_name`, `status`, `result`, `related_document`, `owner`, `date_created`) and `/api/processed_mail/` (one row per mail a rule handled, carries `subject`, `received`, `processed`, `status`, `error`). Observed on Paperless 2.20.15:

- duplicate: `status=FAILURE`, `result="…: It is a duplicate of <title> (#262)."`, `related_document="262"`
- new: `status=SUCCESS`, `related_document="<new id>"`
- e-mail tasks: `owner` = mail rule owner; consume-folder tasks: `owner=null`; API uploads: `owner` = token user
- a mail is `FAILED` when any attachment fails, including on a duplicate; `error` is a Celery traceback whose last line is the useful message

## Decisions

**Status is a tag query, not a new field.** `status` maps to Paperless tag filters inside `LibraryService.listLibrary`:

| status | Paperless filter |
| --- | --- |
| `error` | `tags__id__in` = ids of `ai-error`, `ai-propagation-error`, `ai-index-error` (those that exist) |
| `unprocessed` | `tags__id__none` = ids of all six lifecycle tags |
| `approved` | `tags__id__all` += `ai-approved` |
| `done` | `tags__id__all` += `ai-propagated` |
| `rejected` | `tags__id__all` += `ai-rejected` |

`ai-pending` stays excluded (it is the review tab), so `tags__id__none` becomes a comma list when `unprocessed` is set. Unknown `status` → 422. If a status's tag does not exist yet (e.g. no doc ever failed) the result is empty, not unfiltered. The in-flight pin (page 1) is skipped when `status` is set, because pinned rows would not match the filter. The error set is one exported constant (`ERROR_TAGS`) shared by library, live counts and bulk reprocess.

**Bulk reprocess runs server-side.** `POST /api/documents/reprocess-failed` pages through `ERROR_TAGS` docs (cap 200 per call, reports `remaining` if more) and calls the existing `reprocess(docId)` sequentially. Sequential keeps Paperless PATCH load and the worker's serial queue sane; 200 × (one PATCH + one ping) is a few seconds. Per-doc failures are collected, never abort the batch. Response: `{requested, reprocessed, failed: [{doc_id, detail}], remaining}`. The client-side alternative (loop over loaded rows) was rejected: it reintroduces the "only what's on this page" problem.

**Activity = read-through over Paperless, no new storage for outcomes.** `IngestService.activity(days)`:
1. `gateway.listConsumeTasks()` → `GET /api/tasks/`, keep `task_name=consume_file` with `date_created` inside the window, newest first, cap 500.
2. Outcome: `PENDING|STARTED` → `running`; `SUCCESS` → `new`; `FAILURE` with "duplicate of" → `duplicate` (target id from `related_document`, else `(#N)` in the message; title from the message); other `FAILURE` → `failed` with the message minus the repeated filename prefix.
3. Source: task id in `upload_tasks` → `upload`; `owner === null` → `folder`; otherwise `email`.
4. For `new` and `duplicate` targets, one `searchDocuments({id__in})` fetches current title + tags → `lifecycle_tags` via the existing badge set, so a new row shows "Fehler" / "In Inbox" / "Verarbeitet" live. Docs that no longer exist (trashed) show `doc_missing: true`.
5. `gateway.listProcessedMail()` → mails in the window; `error_summary` = last non-empty line of `error`, truncated to 200 chars.
6. `summary` counts per outcome and per source.

Response shape lives in `ingest.schemas.ts`. Paperless errors map per the nestjs-route-pattern (502 upstream, 503 when no token). `days` is 1–30, default 7.

**Why record upload task ids.** It is the only reliable upload/e-mail discriminator: owner alone can't separate them when the mail rule and the API token belong to the same user (they do here, owner 3). `upload_tasks(task_id text primary key, file_name text, created_at timestamptz default now())`, inserted best-effort after each successful Paperless upload; a write failure logs `upload_task_record_failed` and never fails the upload. Rows older than 30 days are deleted on insert (cheap, bounds the table). Tasks predating the table show as `email` when they have an owner; acceptable and documented.

**Live counts.** `EventsService.computeCounts` adds a fourth concurrent query for `errors`. The SSE payload and the `LiveCounts` type gain `errors`; the SPA treats a missing field as 0 so an old API with a new SPA (dev proxy) still works.

**Polling on /activity.** `staleTime` 10 s; `refetchInterval` 5 s while any item is `running` or a `new` item carries no lifecycle tag yet / `ai-approved`, else off. Matches the upload page cadence without a new SSE channel.

**Consume-folder leftovers.** With Paperless's default `PAPERLESS_CONSUMER_DELETE_DUPLICATES=false`, a duplicate stays in `consume/` and is re-queued (and rejected again) on every Paperless restart; 117 such files exist on the dev host. Setting it to `true` makes Paperless delete the duplicate file after rejecting it. This deletes files, so it is gated on explicit user approval (task 5.1) and called out in the upgrade runbook; every one of those files is a byte-identical copy (SHA1) of a document already in the archive.

## Risks

- `/api/tasks/` is unpaginated and grows forever (723 rows today). Fetched per activity request; fine at this size. If it grows past a few thousand, filter with `?task_name=consume_file` (verify support during implementation) or cache for 10 s.
- The duplicate-title regex depends on Paperless's English message text. Fallback when it doesn't match: show `#<related_document>` without a title.
- Mojibake in Paperless titles inside task messages (`MÃ¤rz`) — we use the title from the live document lookup, not from the message, whenever the doc exists.
