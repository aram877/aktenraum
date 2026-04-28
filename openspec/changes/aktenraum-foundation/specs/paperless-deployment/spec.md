## ADDED Requirements

### Requirement: Docker Compose stack starts all five services
`docker/docker-compose.yml` SHALL define five services: `paperless`, `postgres`, `redis`, `gotenberg`, `tika`. All services SHALL be on a single internal Docker network. Only `paperless` SHALL expose a port, bound to `127.0.0.1:8000`.

#### Scenario: Stack starts cleanly on a fresh host
- **WHEN** `docker compose up -d` is run from `docker/` after volumes exist
- **THEN** all five services reach healthy/running state within 60 seconds

#### Scenario: No service is reachable from outside localhost
- **WHEN** a request is made to the paperless port from a remote machine
- **THEN** the connection is refused (port is not bound to 0.0.0.0)

### Requirement: Volume paths are explicit and documented
The compose file SHALL map volumes to explicit host paths under `~/aktenraum/`: `consume/`, `media/`, `data/`, `pgdata/`, `export/`. No anonymous Docker volumes SHALL be used for persistent data.

#### Scenario: Volume directories are created by setup script
- **WHEN** `scripts/setup.sh` is run on a fresh host
- **THEN** all required host directories under `~/aktenraum/` are created with correct permissions

#### Scenario: Data survives container restart
- **WHEN** `docker compose down` followed by `docker compose up -d` is run
- **THEN** all previously ingested documents are still present in the Paperless UI

### Requirement: Environment variables are fully documented with safe defaults
`docker/.env.example` SHALL document every environment variable consumed by the stack. Required variables (no safe default) SHALL be marked `# REQUIRED`. Defaults SHALL include: `TZ=Europe/Berlin`, OCR languages `deu+eng`, secret key placeholder, DB credentials.

#### Scenario: .env.example is the complete configuration reference
- **WHEN** a developer reads `docker/.env.example`
- **THEN** they can identify every variable that needs a value and what the safe default is, without reading the compose file

### Requirement: Paperless is configured for German-language documents
The deployment SHALL default OCR language to `deu+eng`. The timezone SHALL default to `Europe/Berlin`. The date order SHALL be set to `DMY`.

#### Scenario: German invoice OCR produces readable text
- **WHEN** a German-language PDF invoice is dropped into `~/aktenraum/consume/`
- **THEN** Paperless ingests it and the OCR text contains recognisable German words from the document

### Requirement: A bootstrap script creates required Paperless custom fields
`scripts/bootstrap-paperless.sh` SHALL create all 12 AI custom fields via the Paperless REST API if they do not already exist: `ai_document_type`, `ai_correspondent`, `ai_issue_date`, `ai_due_date`, `ai_expiry_date`, `ai_monetary_amount`, `ai_reference_numbers`, `ai_suggested_tags`, `ai_summary_de`, `ai_confidence`, `ai_backend`, `ai_model`. It SHALL also create the `ai-suggested` and `ai-error` tags.

#### Scenario: Bootstrap is idempotent
- **WHEN** `scripts/bootstrap-paperless.sh` is run twice
- **THEN** it does not create duplicate custom fields or tags, and exits with code 0 both times
