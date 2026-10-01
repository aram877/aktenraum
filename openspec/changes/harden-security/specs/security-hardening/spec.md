## ADDED Requirements

### Requirement: Qdrant requires an API key
Qdrant SHALL reject requests without the configured API key and every aktenraum client SHALL send it.

#### Scenario: unauthenticated request
- **WHEN** a request without `api-key` reaches Qdrant
- **THEN** it is answered with 401

### Requirement: Password change revokes other sessions
A session token SHALL become invalid once the user's password changes.

#### Scenario: second device
- **WHEN** the password is changed on one device
- **THEN** a session cookie from another device returns 401 on `/api/auth/me`

### Requirement: Login is throttled
After 10 failed logins for a username within 15 minutes, further attempts SHALL be refused with 429 and `Retry-After`.

#### Scenario: brute force
- **WHEN** the 11th attempt arrives within the window, even with the right password
- **THEN** the response is 429

### Requirement: Internal secret is checked by value
Internal-call privileges (CSRF bypass, settings and worker endpoints) SHALL require the exact `WEBHOOK_SECRET`, and SHALL be refused when it is empty.

#### Scenario: forged header
- **WHEN** a cross-site POST carries `X-Aktenraum-Secret: guess`
- **THEN** it is rejected with 403

### Requirement: Non-PDF originals never render inline
Preview and download responses for content other than PDF or images SHALL carry `Content-Disposition: attachment` and `Content-Security-Policy: sandbox`.

#### Scenario: HTML original
- **WHEN** a document's original is `text/html`
- **THEN** the preview is served as an attachment with a sandbox CSP

### Requirement: Backups contain documents and databases
Each backup run SHALL store both database dumps and the document files, and the backup container SHALL report unhealthy when any of them is older than 36 hours.

#### Scenario: restore rehearsal
- **WHEN** `task backup:verify` runs
- **THEN** at least one original document and both dumps are restored
