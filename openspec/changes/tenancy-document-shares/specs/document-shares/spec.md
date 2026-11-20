# Spec Delta

## Purpose

How a member shares a single document with another household member, what the recipient may do with it, how revocation and expiry take effect everywhere (aktenraum, Paperless, Ask), and how shares are audited.

## ADDED Requirements

### Requirement: The owner of a document's home space can share it with a household member
The owner of a document's home space SHALL be able to share that document with any other household member as `viewer` or `editor`, with an optional expiry date. A member SHALL have at most one share per document. Sharing with oneself, with a member who is not in the household, or with a member who already belongs to the document's home space SHALL be refused. Nobody else (space editors, space viewers, share recipients) SHALL be able to create, change or revoke shares on the document.

#### Scenario: share as viewer
- **WHEN** A, owner of their personal space, shares document 42 from it with B as viewer
- **THEN** B can open, preview and download document 42 and ask the AI about it

#### Scenario: an editor of the space tries to share
- **WHEN** an editor of the shared space "Haushalt" tries to share one of its documents
- **THEN** the request is refused and no share exists

#### Scenario: a share recipient tries to re-share
- **WHEN** B, who has an editor share on document 42, tries to share it with C
- **THEN** the request is refused and C has no access

#### Scenario: recipient already in the space
- **WHEN** the owner of "Haushalt" shares one of its documents with a member of "Haushalt"
- **THEN** the request is refused with 409 because that member already has access through the space

#### Scenario: second share for the same member
- **WHEN** A shares document 42 with B again
- **THEN** the request is refused with 409, and the existing share stays unchanged (changing it is a role or expiry update)

### Requirement: Share roles are narrower than space roles
A `viewer` share SHALL allow reading, previewing, downloading and asking the AI about the document. An `editor` share SHALL additionally allow correcting the document's AI fields and type fields. Neither role SHALL allow deleting, moving, sharing, approving, rejecting, reprocessing, starring or dismissing a duplicate flag. A shared document SHALL NOT appear in the recipient's review inbox or inbox count.

#### Scenario: editor share corrects a field
- **WHEN** B, who has an editor share on document 42, changes its AI correspondent
- **THEN** the change is saved

#### Scenario: viewer share cannot edit
- **WHEN** B, who has a viewer share, tries to change an AI field
- **THEN** the request is refused and the document is unchanged

#### Scenario: editor share cannot approve or delete
- **WHEN** B, who has an editor share, tries to approve, reprocess, star or delete document 42
- **THEN** each request is refused and the document is unchanged

#### Scenario: pending shared document
- **WHEN** a document still awaiting review is shared with B
- **THEN** it does not appear in B's review inbox and does not count towards B's inbox number

### Requirement: Revoking or expiring a share removes access everywhere at once
The owner SHALL be able to revoke a share and change its role or expiry at any time. A share whose expiry has passed SHALL be treated as absent on every request. On revoke or expiry the document SHALL disappear at once from the recipient's library, "shared with me" list, counts, document access (404) and Ask results, and Paperless SHALL stop granting the recipient access (for an expiry: within 15 minutes).

#### Scenario: revoke
- **WHEN** A revokes B's share on document 42
- **THEN** B gets 404 for document 42, it is gone from B's library and Ask results, and B's own Paperless account can no longer open it

#### Scenario: expiry
- **WHEN** a share on document 42 expires
- **THEN** from that moment B gets 404 for document 42 through aktenraum, and within 15 minutes B's Paperless account loses access and Ask no longer retrieves its text for B

#### Scenario: downgrade
- **WHEN** A changes B's share from editor to viewer
- **THEN** B's next attempt to change a field is refused

#### Scenario: expiry in the past
- **WHEN** A sets an expiry date that has already passed
- **THEN** the request is refused with 422

### Requirement: Shared documents are labelled and listed for both sides
The recipient SHALL see each shared document in their library, marked as shared by the sharing member (without revealing the name of the sharer's space), and SHALL have a list of everything shared with them, showing the role, who shared it and when it expires. The sharer SHALL have a list of everything they shared, with recipient, role and expiry, and SHALL be able to revoke from it. Sharing UI SHALL be hidden while the household has a single member.

#### Scenario: recipient's library
- **WHEN** B opens the library after A shared document 42 with them
- **THEN** document 42 is listed with "Geteilt von A" and B's space filter does not include it

#### Scenario: sharer's list
- **WHEN** A opens "Von mir geteilt"
- **THEN** every active share A created is listed with document, recipient, role and expiry, each with a revoke action

#### Scenario: household of one
- **WHEN** the household has a single member
- **THEN** no sharing control, page or nav entry is shown

### Requirement: A shared document never feeds the recipient's extraction prompts
Few-shot examples, the per-correspondent history hint and duplicate detection SHALL keep using only documents from the same home space. A document shared with a member SHALL NOT be used as an example, hint source or duplicate candidate for that member's own documents.

#### Scenario: few-shot isolation
- **WHEN** B uploads a document while A's document 42 is shared with B
- **THEN** the extraction for B's document does not use document 42 as an example or history source, and document 42 is not reported as its duplicate

### Requirement: Shares are audited and the owner can read the log
Every grant, role or expiry change, revoke and expiry of a share SHALL be recorded with time, document, recipient and acting member. Every access to a shared document by the recipient (opening its detail, preview, download, or the document being cited in an Ask answer) SHALL be recorded, at most once per share and kind of access per hour. The owner of the document's home space SHALL be able to read the audit entries of the document's shares. Recipients and other members SHALL NOT.

#### Scenario: access is logged
- **WHEN** B downloads document 42 through a share
- **THEN** A sees an audit entry "B – Download – <time>" for document 42

#### Scenario: log is private to the owner
- **WHEN** B requests the audit log of document 42
- **THEN** the request is refused
