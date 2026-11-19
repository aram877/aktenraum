## ADDED Requirements

### Requirement: Household, member and personal space exist for every user
At startup the api SHALL ensure one household, one member per `users` row (the first user with role `admin`) and one personal space per member, idempotently.

#### Scenario: existing install starts the new version
- **WHEN** the api starts on a database with one user and no tenancy rows
- **THEN** one household, one admin member linked to that user and one personal space owned by it exist

#### Scenario: restart
- **WHEN** the api restarts
- **THEN** no duplicate household, member or space is created

### Requirement: Every document has exactly one home space
aktenraum SHALL record a home space for every Paperless document in `document_spaces`. New documents SHALL get one before extraction: uploads go to the uploading member's personal space, all other sources to the household admin's personal space. A document that already has a home space SHALL keep it, including on reprocess.

#### Scenario: upload
- **WHEN** a member uploads a file and Paperless creates document 300
- **THEN** document 300's home space is that member's personal space before the extraction starts

#### Scenario: e-mail import
- **WHEN** a document arrives through the mail rule
- **THEN** its home space is the household admin's personal space

#### Scenario: reprocess
- **WHEN** a document with a home space is reprocessed
- **THEN** its home space is unchanged

### Requirement: Paperless mirrors the home space
For every document, Paperless SHALL show `owner` = the Paperless user of the space's owning member and view+change permissions for the space's Paperless group.

#### Scenario: member user sees its documents
- **WHEN** the document list is read through the member's Paperless user
- **THEN** every document of that member's spaces is returned and the count matches `document_spaces`

### Requirement: Shared vocabulary
Tags, document types and correspondents SHALL have `owner = null`, and every code path that creates them SHALL create them with `owner = null`.

#### Scenario: worker creates a new tag during propagation
- **WHEN** propagation creates a tag that did not exist
- **THEN** the tag has no owner and is visible to every Paperless user

### Requirement: RAG chunks carry their space
Every Qdrant chunk payload SHALL include `space_id` and `shared_with`. Retrieval SHALL return only chunks whose `space_id` is one of the caller's spaces or whose `shared_with` contains the caller.

#### Scenario: backfill
- **WHEN** the migration has run
- **THEN** every existing chunk carries the `space_id` of its document's home space, without re-embedding

### Requirement: The AI pipeline stays inside the home space
Few-shot exemplars, the correspondent history hint and duplicate detection for a document SHALL only use documents with the same home space.

#### Scenario: duplicate detection
- **WHEN** two documents in different spaces share correspondent, date, type and amount
- **THEN** they are not flagged as duplicates of each other

### Requirement: Migration is gated, idempotent and verified
The tenancy migration SHALL refuse to run without a restic snapshot of all three tags younger than 2 hours (unless explicitly overridden), SHALL support a dry run that changes nothing, SHALL be safe to re-run, and SHALL end with a verification that compares aktenraum and Paperless and reads the document list through the member's Paperless user.

#### Scenario: no recent backup
- **WHEN** the newest snapshot is 30 hours old
- **THEN** the migration exits without writing anything and says why

#### Scenario: re-run
- **WHEN** the migration runs a second time on a migrated install
- **THEN** every step reports nothing to do
