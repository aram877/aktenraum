## Why

On 2026-10-23 a batch of documents arrived by e-mail while Ollama was being updated. The user could not answer three basic questions from the SPA:

1. **What did the e-mail import actually do?** Paperless ran 142 consume tasks that morning: 25 attachments from the mail "Documents uandi" (6 new, 19 already in the archive) and 117 stale files left in the consume folder that Paperless re-queues on every restart (all duplicates). Paperless marked the mail itself `FAILED` because one attachment was a duplicate. None of this is visible in aktenraum: duplicates are dropped silently, and the only trace is Paperless's task list and `processed_mail` log.
2. **Which documents failed?** Several extractions failed while Ollama was down. The library sidebar hides every `ai-*` tag, so the only way to find `ai-error` docs was paging through the library one page at a time.
3. **Did the rest get processed after the failure?** There is no aggregate view of processing state, so the user had to reprocess one by one and still could not be sure nothing was left behind.

## What Changes

- **Library status filter.** `GET /api/library/` accepts `status=error|unprocessed|approved|done|rejected`; the library page gets a "Status" dropdown (Fehler · Wartet auf KI · Wird übertragen · Fertig · Abgelehnt, plus "In Prüfung" which links to the existing review tab). URL-state like every other filter.
- **Error count everywhere.** The live-counts SSE stream and its poll fallback gain an `errors` count (docs tagged `ai-error`, `ai-propagation-error` or `ai-index-error`). The nav shows a red "N Fehler" pill that links to `/library?status=error`.
- **Bulk reprocess.** `POST /api/documents/reprocess-failed` reprocesses every document currently in the error state (server-side, not limited to the loaded page). The library shows "Alle fehlerhaften erneut verarbeiten (N)" when the Fehler filter is active, with a two-click confirm.
- **Import activity page.** New `GET /api/ingest/activity?days=N` built from Paperless `/api/tasks/` (consume tasks) and `/api/processed_mail/` (mails). New SPA route `/activity` ("Aktivität") lists:
  - the e-mails Paperless processed (subject, received, status, a one-line error summary);
  - every imported file with source (E-Mail / Upload / Ordner), outcome (Neu → link to the doc + its processing badge; Duplikat → "Duplikat von #262 · <title>" link; Fehler → reason; Läuft) and a summary row "N neu · M Duplikate · K Fehler".
- **Upload task bookkeeping.** The upload endpoint records the Paperless task ids it receives in a new `upload_tasks` table, so the activity page can tell uploads from e-mail (Paperless gives e-mail tasks the mail rule's owner and consume-folder tasks no owner, but API uploads also carry an owner).
- **Home page summary.** A small card "Letzte 24 h: N neu · M Duplikate · K Fehler · F fehlerhafte Dokumente" linking to `/activity` and `/library?status=error`.
- **Stop re-queuing duplicate leftovers (approved 2026-10-23).** Set `PAPERLESS_CONSUMER_DELETE_DUPLICATES=true` so a duplicate dropped in the consume folder is removed instead of being re-imported (and rejected) on every Paperless restart.

## Non-goals

- No persistent history beyond what Paperless keeps (its task table and `processed_mail`). The activity page is a window over Paperless's own records.
- No per-e-mail ↔ per-attachment linking. Paperless does not store which task came from which mail; the page groups by source, not by message.
- No acknowledge/hide of tasks. The `days` window is the only filter.
- No change to the worker's retry logic (`extraction_deferred` 3-strike rule stays).

## Capabilities

### Modified Capabilities
- `aktenraum-api`: library `status` filter, `errors` in live counts, bulk reprocess endpoint, ingest activity endpoint, upload task recording.
- `aktenraum-web`: library status dropdown + bulk reprocess button, nav error badge, `/activity` page, home summary card.

## Impact

- **API** (`services/aktenraum-api/src/`): `library/` (status → tag-filter mapping), `events/` (errors count), `documents/` (reprocess-failed), new `ingest/` module (controller/service/schemas), `upload/` (record task ids), `paperless/paperless.gateway.ts` (`listConsumeTasks`, `listProcessedMail`, `searchDocuments` with `id__in`), `db/schema.ts` + `db/schema.sql` (`upload_tasks`), `test/` fake Paperless gains `/api/tasks/` + `/api/processed_mail/`.
- **Web** (`apps/web/app/`): `pages/library/index.vue`, `components/AppNav.vue`, new `pages/activity.vue`, `pages/index.vue`, `composables/useLibrary.ts` + new `useIngestActivity.ts`, `composables/useLiveCounts.ts`, `utils/` status labels.
- **Compose**: `PAPERLESS_CONSUMER_DELETE_DUPLICATES=true` on the paperless service.
- **Docs**: CLAUDE.md (feature rows + library/live-counts notes), `docs/api-reference.md`, `docs/configuration.md`, session note.
- No worker changes. No migration beyond the idempotent `CREATE TABLE IF NOT EXISTS`.
