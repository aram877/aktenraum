## ADDED Requirements

### Requirement: Single secret comparison
Every check of `X-Aktenraum-Secret` against `WEBHOOK_SECRET`, in the api and in the worker, SHALL use one shared constant-time helper from `@aktenraum/core`. The helper SHALL return false when the expected secret is empty or the provided value is not a string, and SHALL NOT reveal the secret's length through timing.

#### Scenario: empty configured secret
- **WHEN** `WEBHOOK_SECRET` is empty and a request sends `X-Aktenraum-Secret: ""`
- **THEN** the comparison fails and the internal endpoint answers 401

#### Scenario: different length
- **WHEN** the provided secret differs in length from the configured one
- **THEN** the comparison fails without an early length check

### Requirement: Internal endpoints are guarded, not checked in controllers
`GET /api/settings/active-llm-model` and `GET /api/settings/active-auto-approve-rules` SHALL be protected by a guard that accepts only a matching `X-Aktenraum-Secret` and answers `401 {"detail": "Bad secret"}` otherwise. No controller SHALL read the secret header itself.

#### Scenario: worker fetches the active model
- **WHEN** the worker calls `/api/settings/active-llm-model` with the correct secret
- **THEN** the response is 200 with `ollama_model`

#### Scenario: missing or wrong secret
- **WHEN** the endpoint is called without the header or with a wrong value
- **THEN** the response is 401 `Bad secret`

### Requirement: User-or-internal routes are guarded, not checked in controllers
`PATCH /api/documents/:id/type-fields` SHALL be protected by a guard that accepts a matching secret, or, when no secret header is present, a valid user session via `AuthGuard`. A present but wrong secret SHALL be rejected with `401 {"detail": "Invalid secret"}` without falling back to the session cookie. No controller SHALL read the session cookie itself.

#### Scenario: worker saves type fields
- **WHEN** the worker PATCHes type fields with the correct secret and no cookie
- **THEN** the fields are saved (200)

#### Scenario: user saves type fields
- **WHEN** a logged-in user PATCHes type fields without a secret header
- **THEN** the fields are saved (200)

#### Scenario: wrong secret with a valid cookie
- **WHEN** a request carries a valid session cookie and a wrong secret
- **THEN** the response is 401 `Invalid secret`

#### Scenario: neither secret nor session
- **WHEN** a request has no secret header and no session
- **THEN** the response is 401 `Not authenticated`

### Requirement: CSRF protection does not depend on the internal secret
The CSRF middleware SHALL decide only from the request method, path and `Sec-Fetch-Site`. A matching `X-Aktenraum-Secret` SHALL NOT exempt a request from the CSRF check.

#### Scenario: cross-site request with the correct secret
- **WHEN** a state-changing request sends `Sec-Fetch-Site: cross-site` and the correct `X-Aktenraum-Secret`
- **THEN** the response is 403 `Cross-site request blocked`

#### Scenario: internal call without Sec-Fetch-Site
- **WHEN** the worker PATCHes type fields (Node `fetch`, no `Sec-Fetch-Site` header) with the correct secret
- **THEN** the CSRF check passes and the guard decides
