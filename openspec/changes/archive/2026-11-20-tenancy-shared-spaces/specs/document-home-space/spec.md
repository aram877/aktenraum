# Spec Delta

## Purpose

Where a document lives: choosing its space when uploading, moving it between spaces, and how its space is shown and filtered across the SPA.

## ADDED Requirements

### Requirement: Uploads can target a space
An upload SHALL accept an optional target space. The target SHALL be a space where the uploader is `owner` or `editor`, otherwise the upload is refused with 403 before anything is sent to Paperless. Without a target, the uploader's personal space SHALL be used. The document's home space SHALL be the target, assigned before extraction.

#### Scenario: upload into a shared space
- **WHEN** an editor of "Haushalt" uploads a file with "Haushalt" as target
- **THEN** the new document's home space is "Haushalt" and every member of "Haushalt" can see it once it is processed

#### Scenario: upload into a space as viewer
- **WHEN** a viewer of "Haushalt" uploads with "Haushalt" as target
- **THEN** the upload is refused with 403 and nothing reaches Paperless

### Requirement: Documents can be moved between spaces
A member SHALL be able to move a document from one space to another when they are `owner` of its current space and `owner` or `editor` of the target. A move SHALL update the home space, the Paperless owner and permissions, and the space recorded on the document's search chunks, together. If one of these steps fails, the document SHALL stay in its original space and the request SHALL fail with 502.

#### Scenario: move into a shared space
- **WHEN** the owner of a personal space moves one of its documents into "Haushalt", where they are an editor
- **THEN** every member of "Haushalt" can read it, its Paperless owner is the owner of "Haushalt", and Ask retrieves it for members of "Haushalt"

#### Scenario: editor moves out
- **WHEN** an editor of "Haushalt" tries to move one of its documents to their personal space
- **THEN** the request is refused and the document stays in "Haushalt"

#### Scenario: search index failure
- **WHEN** updating the search chunks fails during a move
- **THEN** the document's home space and Paperless permissions are back to the original space and the request fails with 502

### Requirement: Several documents can be moved at once
A member SHALL be able to move up to 200 documents to one target space in one request. Each document SHALL be checked and moved independently, and the response SHALL report the outcome per document.

#### Scenario: mixed bulk move
- **WHEN** a member moves three documents, one of which lives in a space where they are only an editor
- **THEN** two are moved and the third is reported as refused, unchanged

### Requirement: The library shows and filters by space
Each library row and each detail page SHALL show the document's space. The library SHALL accept a space filter that returns only documents of that space. The filter SHALL accept only spaces the member belongs to.

#### Scenario: filter
- **WHEN** a member filters the library by "Haushalt"
- **THEN** only documents whose home space is "Haushalt" are listed

### Requirement: The review inbox only lists documents the member can review
The review inbox SHALL list pending documents only from spaces where the member is `owner` or `editor`. Viewers SHALL still see those documents in the library, read-only.

#### Scenario: viewer inbox
- **WHEN** a viewer of "Haushalt" opens the review inbox while a document of "Haushalt" is pending
- **THEN** that document is not in their inbox, and the inbox count excludes it

### Requirement: Space features are hidden for a household of one
While the household has a single member, the SPA SHALL NOT show the spaces page, the space column or filter, the upload picker or the move action. They SHALL appear once a second member exists.

#### Scenario: single member
- **WHEN** the only member of a household opens the library
- **THEN** no space column, space filter or move action is shown
