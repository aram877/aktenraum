## ADDED Requirements

### Requirement: Every authenticated request has exactly one principal
Authentication SHALL produce a `Principal` that is either a member (`memberId`, `username`, `householdRole`, `scopes`, `sessionId`, `authTime`, `clientId`) or a service (`service`, `scopes`). The principal SHALL NOT contain secrets such as the password hash. Controllers SHALL obtain the caller only through `@CurrentPrincipal()`.

#### Scenario: logged-in user
- **WHEN** a request carries a valid session cookie
- **THEN** the handler sees a member principal with the user's id and username and the admin scopes

#### Scenario: worker call
- **WHEN** a request carries the correct internal secret on a route that accepts it
- **THEN** the handler sees a service principal for `worker` with only internal scopes

### Requirement: Every guarded route declares its scope
Every route behind an auth guard SHALL declare the scopes it accepts with `@RequireScope(...)` (any of the listed; none listed means "any authenticated principal"). The guard SHALL answer `403 {"detail": "Insufficient scope"}` when the principal holds none of them, and `403 {"detail": "Route has no scope declaration"}` when the route declares nothing.

#### Scenario: member calls a member route
- **WHEN** the household admin calls `GET /api/library/`
- **THEN** the request succeeds as before

#### Scenario: principal lacks the scope
- **WHEN** a principal without `settings:write` calls `PATCH /api/settings/llm`
- **THEN** the response is 403 `Insufficient scope`

#### Scenario: undeclared route
- **WHEN** a guarded route has no scope declaration
- **THEN** the route inventory test fails, and at runtime the request is refused with 403

### Requirement: Document access is decided by the policy
Routes that address one document by `:doc_id` SHALL declare the action (`read`, `write`, `delete`). The guard SHALL ask `PolicyService.canAccessDocument(principal, docId, action)` and answer `404 {"detail": "Document <id> not found"}` on denial. Until tenancy exists the policy SHALL allow every member and SHALL allow a service principal only `write` with `internal:type-fields-write`.

#### Scenario: member reads a document
- **WHEN** the household admin opens `/api/documents/42/detail`
- **THEN** the policy allows it and the detail is returned

#### Scenario: worker writes type fields
- **WHEN** the worker PATCHes `/api/documents/42/type-fields` with the correct secret
- **THEN** the policy allows the write

#### Scenario: denied document
- **WHEN** the policy denies access to document 42
- **THEN** the response is 404 `Document 42 not found`, indistinguishable from a missing document

### Requirement: Password change reads the hash from the database
`POST /api/auth/change-password` SHALL load the member's current password hash by `memberId` instead of reading it from the request.

#### Scenario: change password
- **WHEN** a logged-in user submits the correct current password and a new one
- **THEN** the password is changed and the cookie cleared, as before
