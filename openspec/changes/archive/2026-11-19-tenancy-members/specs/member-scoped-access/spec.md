# Spec Delta

## Purpose

What each household member can see and change: every member request reaches the document store under that member's own identity, so the store and aktenraum enforce the same isolation between members.

## ADDED Requirements

### Requirement: Member requests reach Paperless as that member
Every request a member makes that reads or changes documents SHALL be sent to Paperless with that member's own Paperless credentials, never with the service credentials. This covers the library (documents, tags, document types), document detail, preview and download, the review inbox, field edits, approve, reject, star, reprocess, delete, the trash, uploads and upload status, live counts, Ask's document search and duplicate candidates.

#### Scenario: a member's private document
- **WHEN** a member lists the library while another member's personal space holds 10 documents
- **THEN** none of those 10 documents appear, the totals and counts exclude them, and opening one by id answers 404

#### Scenario: the household admin
- **WHEN** the household admin lists the library
- **THEN** they see the documents of their own spaces — after the tenancy migration, every document imported before the second member joined

### Requirement: Uploads belong to the uploader from the start
A member's upload SHALL be submitted to Paperless under that member's identity, so the member can follow its processing and the resulting document lands in their personal space.

#### Scenario: member uploads
- **WHEN** a member uploads a file
- **THEN** they can follow its processing status, and the new document appears in their library and nobody else's

### Requirement: Import activity is scoped
A member SHALL see the import activity of their own uploads. The household admin SHALL additionally see mail and consume-folder imports.

#### Scenario: a plain member opens the activity page
- **WHEN** a member opens the import activity
- **THEN** it lists their own uploads and no mail or consume-folder imports

### Requirement: Paperless credentials stay on the server
Member Paperless credentials SHALL be stored encrypted, SHALL never be sent to the browser, and SHALL be replaced automatically when Paperless rejects them or they cannot be decrypted. The api SHALL refuse to start without its encryption key.

#### Scenario: credentials became invalid
- **WHEN** Paperless rejects a member's stored credentials (e.g. after a database restore)
- **THEN** aktenraum obtains new credentials for that member once and retries the request, without the member noticing

#### Scenario: missing key
- **WHEN** the api starts without an encryption key configured
- **THEN** it exits with an error naming the missing setting

### Requirement: Household settings stay with the admin
Only the household admin SHALL change household settings (LLM models, auto-approve rules) and manage members; other members SHALL see these settings read-only or not at all.

#### Scenario: member opens settings
- **WHEN** a plain member opens the settings page
- **THEN** they can change their own password but no household setting, and the member management section is not shown
