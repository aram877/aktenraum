# Spec Delta

## Purpose

How a household member gives a script or integration its own revocable, scoped, expiring access to aktenraum's API without sharing a browser session, and what such a token can and cannot reach.

## ADDED Requirements

### Requirement: Members create named, scoped, expiring tokens
A signed-in member SHALL be able to create a personal access token with a name (1–64 characters), a non-empty set of token scopes and an expiry between 1 and 365 days. Creating a token SHALL require a passkey confirmation within the last 5 minutes. The token value SHALL be shown exactly once, in the creation response, and SHALL contain at least 256 bits of randomness behind the prefix `akt_pat_`.

#### Scenario: create a token
- **WHEN** a member with a fresh passkey confirmation creates a token named "Scanner" with `upload` for 90 days
- **THEN** the response contains the token value once, and the token list shows "Scanner" with `upload`, its expiry and no value

#### Scenario: no recent passkey confirmation
- **WHEN** a member without a passkey confirmation in the last 5 minutes creates a token
- **THEN** it is refused with 403 `step_up_required` and no token exists

#### Scenario: invalid request
- **WHEN** the requested expiry is 0 or more than 365 days, the name is empty or longer than 64 characters, or the scope list is empty
- **THEN** it is refused with 422 and no token exists

### Requirement: Token scopes exclude administration
The scopes a token may carry SHALL be limited to `documents:read`, `documents:write`, `documents:delete`, `upload`, `ai:ask`, `settings:read`, `shares:manage` and `spaces:manage`.

#### Scenario: administrative scope requested
- **WHEN** a member requests a token with `household:admin`, `settings:write` or an unknown scope
- **THEN** it is refused with 422 and no token exists

### Requirement: Active tokens per member are capped
A member SHALL hold at most 25 tokens that are neither expired nor revoked.

#### Scenario: too many tokens
- **WHEN** a member who already holds 25 active tokens creates another
- **THEN** it is refused with 409 and no token exists

### Requirement: The token value is never stored or shown again
The server SHALL store only a one-way hash of the token value. No list, detail, log or audit entry SHALL contain the value. The list SHALL show a short non-secret prefix of the value so the member can recognise a token.

#### Scenario: listing tokens
- **WHEN** a member lists their tokens
- **THEN** each entry shows name, scopes, display prefix, created, expires, last used (time and address) and whether it is active, expired or revoked, and never the value

### Requirement: Tokens authenticate API requests as their member
A request carrying `Authorization: Bearer <token>` with an active token SHALL be handled as a request by the token's member. Its scopes SHALL be the token's scopes intersected with the scopes the member's household role currently grants. Every document access SHALL be decided by the member's spaces and shares exactly as for a browser session; a denied document SHALL be answered with 404. Reads of shared documents through a token SHALL be recorded in the share-access audit like browser reads.

#### Scenario: script uploads a file
- **WHEN** a script sends an upload with a token holding `upload`
- **THEN** the document is uploaded as the member and lands in the member's chosen or personal space

#### Scenario: scope not on the token
- **WHEN** a token holding only `documents:read` is used to delete a document
- **THEN** it is refused with 403 and nothing changes

#### Scenario: document outside the member's reach
- **WHEN** a token is used to read a document that is neither in one of the member's spaces nor shared with the member
- **THEN** it is answered with 404

#### Scenario: who am I
- **WHEN** a token is used on the "current member" endpoint
- **THEN** it returns the member's identity and indicates the request was made with a token

### Requirement: A bearer header is judged alone
When a request carries an `Authorization` header, it SHALL be authenticated by that header alone. A malformed, unknown, expired or revoked token SHALL be refused with 401 even when the request also carries a valid session cookie. A request without an `Authorization` header SHALL be authenticated by the session cookie as before.

#### Scenario: revoked token plus valid cookie
- **WHEN** a request carries a revoked token and a valid session cookie
- **THEN** it is refused with 401

#### Scenario: expired token
- **WHEN** a token is used after its expiry
- **THEN** it is refused with 401

### Requirement: Tokens never reach credential management, step-up actions or live streams
A token SHALL be refused with 403 `session_required`, whatever its scopes, on: managing sessions and devices, passkeys, recovery codes, step-up confirmation, creating/listing/revoking tokens, every action that requires a passkey confirmation, and the live-counts event stream. Reading the current member's identity SHALL be allowed.

#### Scenario: token tries to manage tokens
- **WHEN** a token is used to create or list tokens
- **THEN** it is refused with 403 `session_required` and nothing changes

#### Scenario: token tries a step-up action
- **WHEN** a token holding `documents:delete` is used to empty the trash
- **THEN** it is refused with 403 `session_required` and the trash is unchanged

### Requirement: Members see usage and revoke their tokens
The list SHALL show when and from which address each token was last used, recorded at most once a minute. A member SHALL be able to revoke any of their own tokens from a browser session without a passkey confirmation; a revoked token SHALL stop working on the next request. A member SHALL NOT be able to see or revoke another member's tokens. Removing a member from the household SHALL revoke all of that member's tokens.

#### Scenario: revoke a leaked token
- **WHEN** a member revokes a token
- **THEN** the next request with that token is refused with 401 and the list shows it as revoked

#### Scenario: another member's token
- **WHEN** a member tries to revoke a token belonging to someone else
- **THEN** it is answered with 404 and the token keeps working

#### Scenario: member removed
- **WHEN** the household admin removes a member
- **THEN** every token of that member is refused from then on

### Requirement: Token events are audited and failed attempts are throttled
Creating and revoking a token, and revocation through member removal, SHALL be recorded in the credential audit with the member, the actor, the token's display prefix and the client address. Repeated requests with invalid tokens from one client address SHALL be throttled with 429 and `Retry-After`, using the same limits as failed logins.

#### Scenario: guessing tokens
- **WHEN** one client address sends 10 requests with invalid tokens within 15 minutes
- **THEN** further token requests from that address are refused with 429 until the window passes

### Requirement: Members manage tokens in the app
`/settings → Konto` SHALL offer a token section: the list described above, a create dialog (name, scopes, expiry 30 / 90 / 365 days or a custom number of days up to 365), the new value shown once with a copy button and a warning that it won't be shown again, and a revoke action per token.

#### Scenario: create from the app
- **WHEN** a member creates a token in the app and confirms with the passkey when asked
- **THEN** the value is displayed once with a copy button, and after closing the dialog only the list entry remains
