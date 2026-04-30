## ADDED Requirements

### Requirement: aktenraum-core is a uv workspace member at packages/aktenraum-core

The repository SHALL contain a Python package `aktenraum-core` at `packages/aktenraum-core/`, registered as a member of the root uv workspace, importable as `aktenraum_core`. The package SHALL ship a `py.typed` marker.

#### Scenario: Workspace install resolves the core package

- **WHEN** `uv sync` runs at the repository root
- **THEN** `aktenraum-core` is installed as an editable workspace dependency, and `python -c "import aktenraum_core"` succeeds inside the workspace virtualenv

### Requirement: aktenraum-core exposes LLM backends

The package SHALL provide an `aktenraum_core.llm` subpackage exposing `LLMBackend` (Protocol), `AnthropicBackend`, `OllamaBackend`, and `create_backend`.

`create_backend` SHALL take primitive parameters — `name: str`, `anthropic_api_key: str | None`, `anthropic_model: str`, `ollama_base_url: str`, `ollama_model: str` — and SHALL NOT depend on any service-specific `Settings` class.

#### Scenario: Factory creates Anthropic backend from primitives

- **WHEN** `create_backend("anthropic", anthropic_api_key="sk-...", anthropic_model="claude-sonnet-4-6")` is called
- **THEN** an `AnthropicBackend` instance is returned with the supplied model

#### Scenario: Factory rejects unknown backend names

- **WHEN** `create_backend("nope")` is called
- **THEN** a `ValueError` is raised whose message names the unknown backend

### Requirement: aktenraum-core exposes the Paperless API client

The package SHALL provide an `aktenraum_core.paperless` subpackage exposing `PaperlessClient` and the `LIFECYCLE_TAGS` constant. The value normalisers (`_normalize_date`, `_normalize_monetary`, `_truncate_string_field`) SHALL be reachable at `aktenraum_core.paperless.normalisers` for unit tests.

#### Scenario: Importing PaperlessClient succeeds

- **WHEN** a downstream module runs `from aktenraum_core.paperless import PaperlessClient, LIFECYCLE_TAGS`
- **THEN** both names resolve and `LIFECYCLE_TAGS` contains the six lifecycle tag names (`ai-pending`, `ai-approved`, `ai-rejected`, `ai-propagated`, `ai-propagation-error`, `ai-error`)

### Requirement: aktenraum-core exposes shared extraction models

The package SHALL provide an `aktenraum_core.models` subpackage exposing `DocumentExtraction`, `DocumentType` (StrEnum with the 20 production document types), `KeyDates`, `CoercedStr`, and `CoercedList`.

#### Scenario: DocumentType enum still has 20 members

- **WHEN** a caller iterates `DocumentType`
- **THEN** the enum has exactly 20 members matching the production taxonomy
