# Spec Delta

## Purpose

How members of a household create spaces ("Akten") they manage together, who belongs to each, what each role may do, and how Paperless enforces the same rules.

## ADDED Requirements

### Requirement: Any member can create a shared space and is its only owner
Every household member SHALL be able to create a shared space with a name (1–128 characters, unique among the shared spaces the member belongs to). The creator SHALL become the space's only `owner`. A shared space SHALL always have exactly one owner.

#### Scenario: create
- **WHEN** a member creates a shared space named "Haushalt"
- **THEN** the space exists, the member is its owner, it is empty, and it appears in the member's list of spaces

#### Scenario: duplicate name
- **WHEN** a member creates a second shared space with the name of one they already belong to
- **THEN** the request is refused with 409 and no space is created

### Requirement: The owner manages the members of a shared space
The owner SHALL be able to add any other household member as `editor` or `viewer`, change a member's role between `editor` and `viewer`, and remove a member. Nobody SHALL be able to add a member to, or remove the owner from, a personal space. Non-owners SHALL NOT be able to change membership, except leaving.

#### Scenario: add an editor
- **WHEN** the owner of "Haushalt" adds member B as editor
- **THEN** B lists "Haushalt" among their spaces with role editor and can read and edit every document in it

#### Scenario: an editor tries to add someone
- **WHEN** an editor of a space tries to add another member
- **THEN** the request is refused with 403 and membership is unchanged

#### Scenario: personal space
- **WHEN** anyone tries to add a member to a personal space
- **THEN** the request is refused and the personal space keeps exactly one member

### Requirement: Space roles decide what a member may do with documents
In a space, `viewer` SHALL allow reading, previewing, downloading and asking the AI about its documents. `editor` SHALL additionally allow correcting AI fields, approving, rejecting, reprocessing, starring, uploading into the space and moving documents into it. `owner` SHALL additionally allow deleting documents and moving them out of the space. A member who is not in the space SHALL get 404 for any of its documents.

#### Scenario: viewer cannot edit
- **WHEN** a viewer of "Haushalt" tries to change an AI field of one of its documents
- **THEN** the request is refused and the document is unchanged

#### Scenario: editor cannot delete
- **WHEN** an editor tries to delete a document of the space
- **THEN** the request is refused and the document stays

#### Scenario: outsider
- **WHEN** a member who is not in "Haushalt" requests one of its documents by id
- **THEN** the answer is 404

### Requirement: Non-owners can leave a shared space
An editor or viewer SHALL be able to leave a shared space. The owner SHALL NOT be able to leave. Leaving or being removed SHALL take effect immediately for lists, document access, counts and AI retrieval.

#### Scenario: leave
- **WHEN** an editor leaves "Haushalt"
- **THEN** its documents disappear from their library, their counts and their Ask results at once

### Requirement: Shared spaces can be renamed and deleted when empty
The owner SHALL be able to rename a shared space and delete it once it contains no documents (trashed documents count as contained). Personal spaces SHALL NOT be renamed or deleted through this.

#### Scenario: delete a non-empty space
- **WHEN** the owner deletes a shared space that still holds a document
- **THEN** the request is refused with 409 and the space stays

#### Scenario: delete an empty space
- **WHEN** the owner deletes an empty shared space
- **THEN** it disappears for every former member

### Requirement: Paperless enforces shared-space membership
Each shared space SHALL map to a Paperless writer group (view + change on its documents) holding its owner and editors, and a viewer group (view only) holding its viewers. Documents of a shared space SHALL be owned in Paperless by the space owner. Membership changes SHALL change only group membership, not document permissions. Through their own Paperless token, a member SHALL see exactly the documents of their spaces.

#### Scenario: role change
- **WHEN** the owner changes B from editor to viewer
- **THEN** B's Paperless user moves from the writer group to the viewer group, and a change B makes through Paperless is rejected

### Requirement: Every member can see who is in the household
Every member SHALL be able to list the household's members (id and username), to pick whom to add to a space. Roles, invites and other administrative data stay admin-only.

#### Scenario: directory
- **WHEN** a plain member asks for the household directory
- **THEN** they get every member's id and username and nothing else
