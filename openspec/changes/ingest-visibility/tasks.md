## 1. API — status filter, error count, bulk reprocess

- [x] 1.1 Export `ERROR_TAGS` (`ai-error`, `ai-propagation-error`, `ai-index-error`) from one place in the api
- [x] 1.2 `LibraryQuery.status` + controller validation (422 on unknown); status → tag-filter mapping in `listLibrary`; merge `tags__id__none` into a comma list; skip in-flight pin when `status` is set
- [x] 1.3 `EventsService.computeCounts` adds `errors`; SSE payload + poll fallback carry it
- [x] 1.4 `DocumentsService.reprocessFailed()` + `POST /api/documents/reprocess-failed` (cap 200, sequential, per-doc failures collected, `remaining`)
- [x] 1.5 Tests: each status value, unknown status, missing tag → empty, no pin under status, errors count, bulk reprocess happy path / partial failure / cap

## 2. API — import activity

- [x] 2.1 `upload_tasks` table in `schema.ts` + `schema.sql`; upload service records task ids best-effort, prunes rows > 30 days
- [x] 2.2 Gateway: `listConsumeTasks()`, `listProcessedMail()`; `searchDocuments` with `id__in` (verify Paperless honours it — same silent-ignore class as `?name=`)
- [x] 2.3 New `ingest/` module: schemas, service (outcome/source classification, duplicate parsing, lifecycle lookup, mail error summary, summary counts), controller `GET /api/ingest/activity?days=`
- [x] 2.4 Fake Paperless in `src/test/` serves `/api/tasks/` and `/api/processed_mail/`
- [x] 2.5 Tests: each outcome, each source, duplicate without title match, trashed target (`doc_missing`), mail error summary, `days` bounds, 502 mapping, auth gating

## 3. Web

- [x] 3.1 `useLibrary` passes `status`; library page Status dropdown (URL state, resets page) with the "In Prüfung" → review-tab entry
- [x] 3.2 Bulk reprocess button + two-click confirm + result message + invalidations (`useDocumentActions` or a new mutation)
- [x] 3.3 `LiveCounts.errors` (missing → poll fallback); AppNav red "N Fehler" pill → `/library?status=error`
- [x] 3.4 `useIngestActivity` composable (key `["ingest","activity",{days}]`, conditional 5 s refetch) + `pages/activity.vue` + nav link "Aktivität"; mobile card layout below `md:`
- [x] 3.5 Home summary card
- [x] 3.6 Tests (`mountSuspended`): status URL sync, bulk confirm flow, nav badge visibility, activity rows per outcome, refetch stops when settled

## 4. Verify

- [x] 4.1 `pnpm -r lint`, `pnpm -r build`, `pnpm -r test`, api + web typecheck
- [ ] 4.2 `task build`; in the browser: `/activity` reproduces the 2026-10-23 picture (25 e-mail = 6 neu + 19 Duplikate, 117 Ordner-Duplikate, mail "Documents uandi" FAILED); `/library?status=error` + bulk reprocess against a doc forced into `ai-error`

## 5. Consume-folder duplicates (approved 2026-10-23)

- [x] 5.1 Set `PAPERLESS_CONSUMER_DELETE_DUPLICATES=true` on the paperless service (compose `environment:` — not `.env.example`, existing installs never pick up new template lines — + `docs/configuration.md`); note in the upgrade runbook that the next Paperless start removes the duplicate files sitting in `consume/`

## 7. Library facets (added 2026-10-23)

- [x] 7.1 `ai-duplicate`, `ai-duplicate-dismissed`, `ai-index-error` in the api's `INTERNAL_TAGS` (tag cloud + row tags)
- [x] 7.2 `GET /api/library/types` from Paperless `document_count`; sidebar "Dokumenttypen" chips toggling `?document_type=`
- [x] 7.3 Tests (api facet + types, web chips)

## 6. Docs

- [x] 6.1 CLAUDE.md: feature rows (status filter, activity page), live-counts `errors`, new endpoints, test counts
- [x] 6.2 `docs/api-reference.md`, session note `docs/sessions/2026-10-23.md`
