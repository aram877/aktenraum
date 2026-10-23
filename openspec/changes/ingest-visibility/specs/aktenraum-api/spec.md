## ADDED Requirements

### Requirement: Library status filter
`GET /api/library/` SHALL accept an optional `status` parameter with values `error`, `unprocessed`, `approved`, `done`, `rejected` and SHALL return only documents in that processing state. `ai-pending` documents SHALL remain excluded for every value.

#### Scenario: filter failed documents
- **WHEN** the library is requested with `status=error`
- **THEN** only documents tagged `ai-error`, `ai-propagation-error` or `ai-index-error` are returned, across all pages

#### Scenario: never-processed documents
- **WHEN** the library is requested with `status=unprocessed`
- **THEN** only documents carrying none of the six lifecycle tags are returned

#### Scenario: unknown status
- **WHEN** the library is requested with `status=foo`
- **THEN** the response is 422

#### Scenario: status tag does not exist yet
- **WHEN** `status=error` is requested and none of the error tags exist in Paperless
- **THEN** the result is empty with `total=0`

#### Scenario: no in-flight pin under a status filter
- **WHEN** page 1 is requested with any `status`
- **THEN** no `is_processing` rows are prepended

### Requirement: Error count in live counts
The live-counts payload SHALL include `errors`, the number of documents carrying any error tag.

#### Scenario: failed extraction appears in the count
- **WHEN** a document is tagged `ai-error`
- **THEN** the next live-counts event reports `errors` ≥ 1

### Requirement: Bulk reprocess of failed documents
`POST /api/documents/reprocess-failed` SHALL reprocess every document in the error state (up to 200 per call) using the same semantics as single-document reprocess, and SHALL report per-document failures without aborting.

#### Scenario: all failed documents reprocessed
- **WHEN** three documents are tagged `ai-error` and the endpoint is called
- **THEN** all three lose their lifecycle tags, the auto-tagger is pinged for each, and the response reports `reprocessed=3`

#### Scenario: one document fails
- **WHEN** one of the PATCHes is rejected by Paperless
- **THEN** the others are still reprocessed and the failing id appears in `failed`

#### Scenario: more than the cap
- **WHEN** 250 documents are in the error state
- **THEN** 200 are reprocessed and `remaining=50`

### Requirement: Import activity
`GET /api/ingest/activity?days=N` (1–30, default 7, auth-gated) SHALL return the Paperless consume tasks and processed mails from the last N days, each consume task classified by source (`email`, `upload`, `folder`) and outcome (`new`, `duplicate`, `failed`, `running`), plus summary counts.

#### Scenario: duplicate import
- **WHEN** a consume task failed with "It is a duplicate of … (#262)"
- **THEN** the item has `outcome=duplicate` and `duplicate_of.id=262` with the current title of document 262

#### Scenario: new document shows processing state
- **WHEN** a consume task succeeded with `related_document=270` and document 270 is tagged `ai-error`
- **THEN** the item has `outcome=new`, `doc_id=270` and `lifecycle_tags` containing `ai-error`

#### Scenario: source classification
- **WHEN** a task id was recorded by the upload endpoint
- **THEN** its source is `upload`; a task with no owner is `folder`; any other task is `email`

#### Scenario: failed mail
- **WHEN** Paperless marked a processed mail `FAILED` with a traceback
- **THEN** the mail entry carries `status=FAILED` and `error_summary` set to the traceback's last line

#### Scenario: Paperless unreachable
- **WHEN** Paperless returns 5xx for `/api/tasks/`
- **THEN** the endpoint responds 502 with a `{detail}` body

### Requirement: Upload task recording
The upload endpoint SHALL record each Paperless task id it receives in `upload_tasks`, best-effort.

#### Scenario: database write fails
- **WHEN** inserting into `upload_tasks` throws
- **THEN** the upload response is unchanged and `upload_task_record_failed` is logged
