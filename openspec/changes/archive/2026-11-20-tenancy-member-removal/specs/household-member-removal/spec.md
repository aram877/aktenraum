# Spec Delta

## Purpose

How the household admin removes a member from the household: who may be removed, how the member's access ends, how their documents, shared spaces and shares are handed to a successor without orphaning anything, and how Paperless and Ask are brought in line, even after an interruption.

## ADDED Requirements

### Requirement: Only the household admin removes members, and never the admin
Only the household admin SHALL be able to remove a member. The household admin SHALL NOT be removable, and a member SHALL NOT be able to remove themselves. Removing a member who is already removed or does not exist SHALL answer 404. The request SHALL name the member's username as confirmation; a mismatch SHALL be refused with 422 and change nothing.

#### Scenario: admin removes a member
- **WHEN** the household admin removes member B, confirming with B's username
- **THEN** the removal succeeds and B is no longer listed as a household member

#### Scenario: a plain member tries to remove someone
- **WHEN** member B tries to remove member C
- **THEN** the request is refused with 403 and C stays a member

#### Scenario: admin targets themselves
- **WHEN** the household admin tries to remove their own member
- **THEN** the request is refused with 409 and nothing changes

#### Scenario: wrong confirmation
- **WHEN** the admin removes B but confirms with "C"
- **THEN** the request is refused with 422 and B stays a member with all their access

#### Scenario: removing twice
- **WHEN** the admin removes B a second time
- **THEN** the request answers 404

### Requirement: The admin chooses a successor among the remaining members
A removal SHALL name a successor: a current, not removed household member other than the removed member. When the request names none, the household admin SHALL be the successor. A successor who is removed, unknown, or the removed member themselves SHALL be refused with 422.

#### Scenario: default successor
- **WHEN** the admin removes B without naming a successor
- **THEN** the household admin becomes B's successor

#### Scenario: named successor
- **WHEN** the admin removes B and names C as successor
- **THEN** C becomes B's successor

#### Scenario: invalid successor
- **WHEN** the admin removes B and names B, or an already removed member, as successor
- **THEN** the request is refused with 422 and B stays a member

### Requirement: A removed member loses all access immediately
From the moment a removal is accepted, the removed member's existing sessions SHALL be rejected with 401, a login with their username and correct password SHALL fail exactly like a wrong password, and their Paperless user SHALL be unable to authenticate. This SHALL hold even when moving their documents or updating Paperless permissions has not finished yet.

#### Scenario: open session after removal
- **WHEN** B is removed while B has an open browser session
- **THEN** B's next request answers 401

#### Scenario: login after removal
- **WHEN** B logs in with the correct password after being removed
- **THEN** the login fails with the same answer as a wrong password

#### Scenario: Paperless token after removal
- **WHEN** B's former Paperless API token is used against Paperless after the removal
- **THEN** Paperless rejects it

#### Scenario: removal with an unreachable Paperless
- **WHEN** B is removed while Paperless is unreachable
- **THEN** B is still locked out of aktenraum at once, and Paperless deactivation is completed by the removal sync once Paperless answers

### Requirement: The removed member's personal documents move to the successor's personal space
Every document whose home space is the removed member's personal space SHALL get the successor's personal space as its home space, including documents in the Paperless trash. No document SHALL be left without a home space by a removal.

#### Scenario: personal documents
- **WHEN** B, who has 30 documents in their personal space, is removed with successor A
- **THEN** all 30 documents have A's personal space as home space and A can open, edit, move and delete them

#### Scenario: trashed document
- **WHEN** B had a document in the trash at removal and A later restores it
- **THEN** the restored document's home space is A's personal space and A can open it

### Requirement: Shared spaces owned by the removed member get the successor as owner
Every shared space the removed member owns SHALL get the successor as its single owner. A successor who was already an editor or viewer of that space SHALL become its owner. The space's other members, roles and documents SHALL stay unchanged.

#### Scenario: successor outside the space
- **WHEN** B owns "Wohnung" with C as editor and is removed with successor A
- **THEN** A owns "Wohnung", C is still an editor, and every document of "Wohnung" stays in it

#### Scenario: successor already a viewer
- **WHEN** B owns "Wohnung", A is a viewer there, and B is removed with successor A
- **THEN** A is the owner of "Wohnung" and holds no viewer role there any more

### Requirement: The removed member leaves every other shared space
The removed member SHALL lose every editor and viewer membership in shared spaces they do not own, in aktenraum and in Paperless.

#### Scenario: membership in someone else's space
- **WHEN** B is an editor of A's space "Haushalt" and is removed
- **THEN** "Haushalt" no longer lists B and B's Paperless user is in none of its groups

### Requirement: Shares the removed member received are revoked
Every share whose recipient is the removed member SHALL be revoked, recorded in the share audit log as `revoked` with the household admin as actor, and removed from Paperless permissions and the Ask index.

#### Scenario: received share
- **WHEN** C shared document 42 with B and B is removed
- **THEN** document 42 has no share for B, its audit log shows `revoked` by the admin, and "Von mir geteilt" for C no longer lists it

### Requirement: Shares the removed member granted pass to the successor
Shares on documents that move to the successor, or that stay in a shared space the successor now owns, SHALL stay active and become manageable by the successor as the new home-space owner. A share whose recipient is the successor, or a member of the document's new home space, SHALL be ended and recorded as `revoked` with the household admin as actor.

#### Scenario: share to a third member
- **WHEN** B shared a document from their personal space with C and is removed with successor A
- **THEN** C keeps access, and A sees and can revoke the share

#### Scenario: share to the successor
- **WHEN** B shared a document with A and is removed with successor A
- **THEN** the share is ended, recorded as `revoked`, and A keeps access as owner of the document's new home space

### Requirement: Uploads still in flight follow the successor
A document created from an upload by a member who has since been removed SHALL get the successor's personal space as its home space, also when the upload targeted a shared space the removed member could place documents into.

#### Scenario: upload finishes after removal
- **WHEN** B uploaded a file, was removed with successor A, and Paperless created the document afterwards
- **THEN** the new document's home space is A's personal space

### Requirement: Paperless and Ask reflect the removal
After a removal completes, every affected document's Paperless owner, group and user permissions SHALL match its new home space and active shares, the removed member's Paperless user SHALL be inactive and in no group, and the Ask index SHALL neither return the moved documents to the removed member nor hide them from the successor.

#### Scenario: Paperless permissions after the move
- **WHEN** B's personal documents have moved to A
- **THEN** in Paperless they are owned by A's Paperless user and B's Paperless user has no permission on them

#### Scenario: Ask after the move
- **WHEN** A asks the AI about a document that was in B's personal space
- **THEN** the document can be retrieved and cited for A

### Requirement: An interrupted removal completes on its own
When Paperless or the Ask index fails during a removal, the database changes SHALL remain in place, the removal SHALL be reported as still completing, and the system SHALL retry the outstanding Paperless and Ask updates automatically (also after a restart) until they succeed. Retrying SHALL be idempotent.

#### Scenario: Paperless fails mid-removal
- **WHEN** Paperless fails while B's documents are being re-mirrored
- **THEN** the request still succeeds, the member list shows the removal as completing, and a later retry finishes it without further admin action

#### Scenario: restart during completion
- **WHEN** the api restarts before a removal's Paperless updates finished
- **THEN** the updates are completed after startup and the removal shows as complete

### Requirement: The admin sees what a removal will do before confirming
The household admin SHALL be able to request, for a member and successor, the number of personal documents that will move, the shared spaces that will change owner, the shared spaces the member will leave, and the shares that will be revoked or pass on, without changing anything.

#### Scenario: preview
- **WHEN** the admin opens the removal dialog for B with successor A
- **THEN** the dialog shows how many documents move, which spaces change owner or lose B, and how many shares are revoked or kept, and nothing has changed yet

### Requirement: A removed member is kept as history, not as a member
A removed member SHALL NOT appear in the household member list, the member directory, space member pickers or share pickers, and SHALL NOT be accepted as a share recipient, space member or successor. Their username SHALL stay taken, and existing audit entries SHALL still show their username. A removal SHALL NOT be undoable.

#### Scenario: share picker after removal
- **WHEN** A opens the share panel after B was removed
- **THEN** B is not offered as a recipient, and a direct API request to share with B is refused

#### Scenario: audit history
- **WHEN** A reads the audit log of a document B once accessed through a share
- **THEN** the entries still name B

#### Scenario: username reuse
- **WHEN** someone redeems an invite with B's former username
- **THEN** the redemption is refused with 409 "Benutzername bereits vergeben"
