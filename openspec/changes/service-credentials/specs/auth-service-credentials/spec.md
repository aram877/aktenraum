# Spec Delta

## Purpose

How the internal callers (Paperless's post-consume hook, the worker and the api) prove who they are to each other, which calls each of them may make, and how a misconfigured credential shows up.

## ADDED Requirements

### Requirement: Each internal caller has its own credential
There SHALL be one credential for each internal caller: the Paperless hook, the worker and the api. A caller SHALL send its credential as `Authorization: Bearer <credential>`. The former shared secret header (`X-Aktenraum-Secret`) SHALL NOT authenticate any call.

#### Scenario: the old shared header
- **WHEN** a request to an internal worker or api endpoint carries only the old `X-Aktenraum-Secret` header with the old shared value
- **THEN** it is rejected with 401 and nothing is queued or changed

#### Scenario: unknown credential
- **WHEN** a request carries a bearer value that matches no configured credential
- **THEN** it is rejected with 401

### Requirement: Each caller may make only its own calls
A recognised caller SHALL be allowed exactly these calls, and any other internal call SHALL be refused with 403 without effect:
- Paperless hook → worker: start extraction of a document.
- api → worker: start extraction, start propagation, refresh a document's search metadata, read which documents are being processed.
- worker → api: read the active model and auto-approve settings, write type-specific fields, assign and read a document's home space.

#### Scenario: hook starts extraction
- **WHEN** the Paperless hook posts a document id to the worker's extraction trigger with its credential
- **THEN** the document is queued for extraction

#### Scenario: hook tries more than extraction
- **WHEN** the Paperless hook's credential is used for the propagation trigger, the processing list, or any api endpoint
- **THEN** the request is refused (403 at the worker; at the api it is not accepted as the worker) and nothing is queued, read or changed

#### Scenario: worker credential sent back to the worker
- **WHEN** the worker's own credential is used to call a worker trigger
- **THEN** the request is refused with 403

#### Scenario: api credential at the api
- **WHEN** the api's credential is used on an api endpoint meant for the worker
- **THEN** the request is refused and nothing changes

### Requirement: Worker credential on routes members can also use
An api route that both members and the worker use SHALL authenticate a request that carries a bearer credential by that credential alone. A wrong or non-worker credential SHALL be refused with 401 and SHALL NOT fall back to the session cookie. A request without a bearer credential SHALL be authenticated by the member's session as before.

#### Scenario: wrong credential plus a valid session cookie
- **WHEN** a request to the type-fields endpoint carries a valid member session cookie and a bearer value that is not the worker credential
- **THEN** it is refused with 401

#### Scenario: member without a bearer credential
- **WHEN** a signed-in member edits type fields from the app
- **THEN** it succeeds under the member's own permissions

### Requirement: Missing or ambiguous credentials fail closed
When a credential is not configured, every call that needs it SHALL be refused, and the service SHALL log at startup which credentials are missing. When two credentials have the same value, the service SHALL treat both as missing and log it, because the callers could not be told apart. A browser request without a bearer credential SHALL never be treated as an internal caller.

#### Scenario: hook token missing
- **WHEN** the worker starts without the hook credential configured
- **THEN** it logs that the hook credential is unset, every hook call is refused, and the api's calls with a valid api credential still work

#### Scenario: duplicated values
- **WHEN** the worker and api credentials are configured with the same value
- **THEN** both services log the duplication and refuse calls that present that value

### Requirement: Internal calls name their caller in the logs
Accepted and rejected internal calls SHALL be logged with the caller's name (`paperless-hook`, `api`, `worker`) when the credential was recognised. A rejection SHALL record whether the credential was unknown (401) or not allowed for that call (403). Credential values SHALL never be logged.

#### Scenario: hook-triggered extraction is attributable
- **WHEN** the hook queues document 42
- **THEN** the worker's log line for it names `paperless-hook` as the caller

#### Scenario: refused call is attributable
- **WHEN** the hook's credential is used for the propagation trigger
- **THEN** the worker logs a rejection naming `paperless-hook` and the refused trigger, without the credential value

### Requirement: Each service holds only the credentials it uses
The Paperless container SHALL receive only the hook credential. The api SHALL receive the worker credential (to verify it) and its own (to send it), and SHALL NOT receive the hook credential. The worker SHALL receive the hook and api credentials (to verify them) and its own. No other container SHALL receive any of them.

#### Scenario: Paperless container environment
- **WHEN** the environment of the running Paperless container is inspected
- **THEN** the worker and api credentials are empty or absent

### Requirement: Credentials are created by the install and upgrade path
The install and upgrade secret bootstrap SHALL generate any missing credential with at least 256 bits of randomness, SHALL leave existing values untouched, and SHALL be safe to run repeatedly. After an upgrade with freshly generated credentials and all services recreated, document intake, approval, propagation and Ask SHALL work without other manual steps.

#### Scenario: upgrade of an install that only has the old shared secret
- **WHEN** the bootstrap runs on an install whose configuration has the old shared secret but no per-caller credentials
- **THEN** the three credentials are generated, the old value is kept (unused), and a rerun changes nothing

#### Scenario: webhook lost during the upgrade
- **WHEN** a document finishes consuming while the services hold mismatched credentials during a recreate
- **THEN** the hook call is refused, Paperless still accepts the document, and the worker's periodic poll queues it for extraction
