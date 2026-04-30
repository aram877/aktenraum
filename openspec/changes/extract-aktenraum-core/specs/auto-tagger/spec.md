## MODIFIED Requirements

### Requirement: Auto-tagger sources its LLM backends, Paperless client, and shared models from aktenraum-core
The auto-tagger SHALL NOT contain its own copy of the LLM backends (`anthropic_backend`, `ollama_backend`, `base`, `factory`), the Paperless API client, or the shared extraction Pydantic models. It SHALL declare `aktenraum-core` as a workspace dependency and import those modules from `aktenraum_core`. The auto-tagger SHALL retain ownership of `tagger.py` (extraction prompt + routing), `propagator.py` (approval-to-native-fields watcher), `webhook.py` (HTTP listener), `main.py` (composition root), and `config.py` (service-specific settings).

#### Scenario: Moved modules no longer exist under auto-tagger
- **WHEN** `services/auto-tagger/src/auto_tagger/` is inspected
- **THEN** `models.py`, `paperless.py`, and the `llm/` directory are absent

#### Scenario: Auto-tagger composition root uses the core factory with primitives
- **WHEN** `auto_tagger.main` constructs the LLM backend at startup
- **THEN** it calls `aktenraum_core.llm.create_backend(name=settings.llm_backend, anthropic_api_key=..., anthropic_model=..., ollama_base_url=..., ollama_model=...)` rather than passing a `Settings` object

#### Scenario: Existing test suite still passes against the moved modules
- **WHEN** `uv run pytest` runs from the repository root
- **THEN** all 97+ existing auto-tagger tests pass, with imports for moved modules now resolving to `aktenraum_core.*` instead of `auto_tagger.*`

#### Scenario: Container image builds from the workspace root
- **WHEN** `docker compose up -d --build auto-tagger` runs
- **THEN** the build succeeds with `services/auto-tagger/Dockerfile` operating on a repository-root build context, and the resulting container starts cleanly with the auto-tagger entrypoint
