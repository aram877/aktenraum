## ADDED Requirements

### Requirement: Auto-tagger polls Paperless for unprocessed documents
The service SHALL poll `GET /api/documents/` every 30 seconds (configurable via `POLL_INTERVAL_SECONDS`). A document is considered unprocessed if it does not have the `ai-suggested` tag AND does not have the `ai-error` tag. The service SHALL process at most `BATCH_SIZE` (default: 5) documents per poll cycle.

#### Scenario: New document is detected and queued
- **WHEN** a document is ingested by Paperless and has neither `ai-suggested` nor `ai-error` tag
- **THEN** the auto-tagger picks it up within `POLL_INTERVAL_SECONDS` seconds of the next poll cycle

#### Scenario: Already-processed documents are skipped
- **WHEN** a document already has the `ai-suggested` tag
- **THEN** the auto-tagger does not re-process it

### Requirement: LLM backend is selectable via environment variable
The service SHALL support two backends: `anthropic` and `ollama`, selected by `LLM_BACKEND` env var (default: `anthropic`). Both SHALL implement the same `LLMBackend` protocol with a `complete(messages, response_schema) -> BaseModel` method. Switching backends SHALL require no code changes.

#### Scenario: Anthropic backend is used by default
- **WHEN** `LLM_BACKEND` is unset or set to `anthropic`
- **THEN** the service sends extraction requests to the Anthropic API using `claude-sonnet-4-6`

#### Scenario: Ollama backend is selectable
- **WHEN** `LLM_BACKEND=ollama` and `OLLAMA_BASE_URL` is set
- **THEN** the service sends extraction requests to the Ollama endpoint

### Requirement: Structured extraction produces a validated DocumentExtraction
For each document, the service SHALL call the LLM with the full OCR text (truncated to `MAX_TOKENS_INPUT`, default 8000 tokens) and extract a `DocumentExtraction` containing: `document_type` (one of the 10 German enum values), `correspondent`, `key_dates` (issue, due, expiry — each nullable), `monetary_amount` (nullable string, e.g. "149,99 EUR"), `reference_numbers` (list of strings), `suggested_tags` (list of strings), `summary_de` (3 sentences in German), `confidence` (float 0–1).

#### Scenario: Valid extraction is produced for a German invoice
- **WHEN** the OCR text of a Rechnung is sent to the configured backend
- **THEN** the returned `DocumentExtraction` has `document_type = "Rechnung"`, a non-null `monetary_amount`, and a 3-sentence `summary_de`

#### Scenario: LLM returns invalid JSON or wrong schema
- **WHEN** the LLM response cannot be parsed into `DocumentExtraction`
- **THEN** the document is tagged `ai-error`, the error is logged, and the service continues to the next document

### Requirement: Extraction results are written to Paperless custom fields
After successful extraction, the service SHALL write all non-null fields to their corresponding Paperless custom fields via `PATCH /api/documents/{id}/` and add the `ai-suggested` tag. The `ai_backend` and `ai_model` fields SHALL always be written.

#### Scenario: Custom fields appear in Paperless UI after processing
- **WHEN** the auto-tagger successfully processes a document
- **THEN** the document's detail view in Paperless shows populated `ai_*` custom fields and the `ai-suggested` tag

#### Scenario: Failed write does not crash the service
- **WHEN** the Paperless API returns a non-2xx response during the PATCH
- **THEN** the error is logged, the document is not tagged (retried on next poll), and the service continues

### Requirement: LLM prompt is in German
The system prompt sent to the LLM SHALL be written in German. It SHALL instruct the model to extract structured data from German personal documents and return the `document_type` using exactly the 10 canonical enum values: `Rechnung`, `Vertrag`, `Behördenbrief`, `Versicherung`, `Mahnung`, `Kontoauszug`, `Garantie`, `Arztbrief`, `Steuer`, `Sonstiges`.

#### Scenario: Prompt language is German
- **WHEN** the service constructs the LLM request
- **THEN** the system prompt is written entirely in German

#### Scenario: document_type is always one of the 10 canonical values
- **WHEN** the extraction schema is validated by Pydantic
- **THEN** any value not in the enum causes a `ValidationError`, preventing it from being written to Paperless

### Requirement: Input text is truncated to avoid token limit errors
If the document OCR text exceeds `MAX_TOKENS_INPUT` (default 8000) tokens (estimated by character count ÷ 4), the service SHALL truncate the text and append a note that the document was truncated.

#### Scenario: Long document is truncated, not rejected
- **WHEN** a document's OCR text exceeds 32,000 characters
- **THEN** the text is truncated to approximately 32,000 characters and extraction proceeds

### Requirement: Service is configurable via environment variables
All runtime parameters SHALL be configurable via env vars with documented defaults in `services/auto-tagger/.env.example`: `LLM_BACKEND`, `ANTHROPIC_API_KEY`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `PAPERLESS_BASE_URL`, `PAPERLESS_API_TOKEN`, `POLL_INTERVAL_SECONDS`, `BATCH_SIZE`, `MAX_TOKENS_INPUT`, `LOG_LEVEL`.

#### Scenario: Service starts with only required vars set
- **WHEN** only `PAPERLESS_BASE_URL`, `PAPERLESS_API_TOKEN`, and `ANTHROPIC_API_KEY` are set
- **THEN** the service starts successfully using defaults for all other parameters

### Requirement: Service runs as a Docker container
`services/auto-tagger/Dockerfile` SHALL produce a minimal Python image. `docker/docker-compose.yml` SHALL include the auto-tagger as a sixth service, depending on `paperless`, with its env file mounted. It SHALL restart on failure (`restart: unless-stopped`).

#### Scenario: Auto-tagger starts as part of the compose stack
- **WHEN** `docker compose up -d` is run after the `.env` files are populated
- **THEN** the auto-tagger container starts and begins its polling loop, visible in `docker compose logs auto-tagger`
