## ADDED Requirements

### Requirement: Side-by-side routing for API and SPA slices
For the API and SPA capabilities (which can safely serve traffic concurrently with their Python/React counterparts), the system SHALL support routing a request to either the old or new implementation without redeploying either service, via nginx routing rules and/or a runtime flag.

#### Scenario: Routing flag selects implementation
- **WHEN** the routing configuration designates the Node API as active for `/api/*`
- **THEN** requests are proxied to the Node API service; reverting the configuration and reloading nginx routes the same paths back to the Python API without restarting either container

### Requirement: No concurrent-live worker instances
The system SHALL NOT run the Python auto-tagger and the Node worker against the same live Paperless/Postgres/Qdrant instance at the same time. Exactly one worker implementation SHALL be active per environment at any moment.

#### Scenario: Worker cutover is atomic
- **WHEN** the Node worker is promoted to active in an environment
- **THEN** the Python auto-tagger container is stopped before or immediately as the Node worker starts polling/listening for the same Paperless instance — there is no window where both are simultaneously enqueuing work from the same source

### Requirement: Old implementation stays deployable until its parity gate passes
For each capability slice, the outgoing (Python/React) implementation's service definition, image, and code SHALL remain present and startable until that slice's parity gate (equivalent test suite passing, plus — where applicable — the RAG eval harness and a manual QA pass) has been confirmed, so a rollback never requires reconstructing deleted code.

#### Scenario: Rollback within a phase requires no rebuild
- **WHEN** a defect is found in the Node API after it has been made active but before `services/aktenraum-api/` (Python) has been deleted
- **THEN** reverting to the Python API is a routing-configuration change plus `docker compose up -d`, not a code restoration
