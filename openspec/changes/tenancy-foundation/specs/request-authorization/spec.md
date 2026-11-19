## ADDED Requirements

### Requirement: The member principal carries tenancy ids
A member principal SHALL carry `memberId` = `members.id`, `userId` = `users.id` and `householdId`, in addition to the fields introduced by `principal-and-policy`. The JWT keeps carrying `users.id`; the guard resolves the member from it.

#### Scenario: logged-in user
- **WHEN** a request carries a valid session cookie
- **THEN** the handler sees a member principal with the member id, the user id, the household id and the scopes of the member's household role

#### Scenario: change password
- **WHEN** a member changes the password
- **THEN** the password hash is loaded and written by `userId`, not `memberId`

### Requirement: Document access follows space membership
`PolicyService.canAccessDocument` SHALL allow a member when the document's home space is one of the member's spaces with a role that permits the action (`viewer`: read; `editor`: read, write; `owner`: read, write, delete), and SHALL allow a service principal only what its scopes grant. Denials stay `404 Document <id> not found`.

#### Scenario: member reads a document in its personal space
- **WHEN** the household admin opens a document whose home space is the admin's personal space
- **THEN** the policy allows it

#### Scenario: document without a home space
- **WHEN** a document has no `document_spaces` row yet (arrived between deploy and assignment)
- **THEN** the policy allows the household admin and denies everyone else
