## ADDED Requirements

### Requirement: Live discovery of locally-pulled Ollama models
The system SHALL provide an authenticated endpoint that returns the list of model tags currently pulled in the configured Ollama instance, so the operator can pick from what's actually available rather than guessing a tag name.

#### Scenario: Ollama reachable and backend is ollama
- **WHEN** an authenticated user requests the available-models endpoint and `LLM_BACKEND=ollama` and Ollama responds successfully
- **THEN** the response contains the list of model tags Ollama reports as locally pulled

#### Scenario: Ollama unreachable
- **WHEN** an authenticated user requests the available-models endpoint and the configured Ollama instance does not respond (timeout or connection error)
- **THEN** the response is HTTP 200 with an empty model list, not an error status

#### Scenario: Backend is not ollama
- **WHEN** an authenticated user requests the available-models endpoint and `LLM_BACKEND=anthropic`
- **THEN** the response is HTTP 200 with an empty model list

#### Scenario: Unauthenticated request rejected
- **WHEN** a request to the available-models endpoint carries no valid session
- **THEN** the system responds with HTTP 401

### Requirement: Selectable extraction and answer models stored as literal Ollama tags
The system SHALL store the operator's chosen extraction model and answer model as literal Ollama model-tag strings (not a symbolic quality tier), independently for extraction and for answer generation, and SHALL accept any non-empty tag up to 128 characters without validating it against the live-pulled list.

#### Scenario: Save a model not in any hardcoded list
- **WHEN** an authenticated user submits `"gemma4:e4b"` as the extraction model via the settings update endpoint
- **THEN** the system persists `"gemma4:e4b"` as the active extraction model and subsequent reads of the active-model setting return `"gemma4:e4b"`

#### Scenario: Extraction and answer models are independent
- **WHEN** an authenticated user sets the extraction model to one tag and the answer model to a different tag
- **THEN** the two settings are stored and read back independently, and changing one does not change the other

#### Scenario: Reject empty model value
- **WHEN** an authenticated user submits an empty string as the model value
- **THEN** the system rejects the update with a validation error and the previously stored value is unchanged

#### Scenario: Reject overlong model value
- **WHEN** an authenticated user submits a model string longer than 128 characters
- **THEN** the system rejects the update with a validation error

### Requirement: Auto-tagger internal model-resolution contract is preserved
The system SHALL continue to expose the currently-active extraction model to the auto-tagger via the existing secret-gated internal endpoint, using the same response field name (`ollama_model`) the auto-tagger already parses, so the auto-tagger requires no code change.

#### Scenario: Auto-tagger fetches the active extraction model
- **WHEN** the auto-tagger calls the internal active-model endpoint with a valid (or unset) shared secret
- **THEN** the response is JSON containing an `ollama_model` field whose value is the currently stored extraction model tag

#### Scenario: Internal endpoint rejects bad secret
- **WHEN** `WEBHOOK_SECRET` is configured and the caller's `X-Aktenraum-Secret` header does not match
- **THEN** the system responds with HTTP 401 and does not reveal the active model

### Requirement: Existing installs migrate from quality tiers to concrete model tags automatically
The system SHALL, on schema upgrade, translate any existing stored quality-tier value (`"high"` or `"medium"`) to the concrete model tag that tier previously resolved to, with no operator action required.

#### Scenario: Fresh upgrade from a pre-change install
- **WHEN** an existing installation with `llm_quality="high"` and `answer_llm_quality="medium"` runs the database migration
- **THEN** after migration the stored extraction and answer models are both the concrete model tag the respective tier used to resolve to, and the settings endpoints return those concrete values

### Requirement: Settings UI selects from live models with a manual-entry fallback
The SPA settings page SHALL present the extraction model and the answer model as independently selectable, populated from the live available-models list when non-empty, and SHALL allow entering a model tag manually when the live list is empty or unreachable.

#### Scenario: Live list available
- **WHEN** the available-models endpoint returns a non-empty list
- **THEN** the settings page renders a selectable list of those models for both the extraction and answer model pickers, with the currently active model pre-selected even if it is not present in the live list

#### Scenario: Live list empty or unreachable
- **WHEN** the available-models endpoint returns an empty list
- **THEN** the settings page allows the operator to enter a model tag manually and save it
