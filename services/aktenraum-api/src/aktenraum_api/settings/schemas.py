from __future__ import annotations

from pydantic import BaseModel, field_validator

# Seed default for a fresh app_settings row (see settings/service.py's
# get_row). Both the extraction and answer model default to the same
# capable local model out of the box.
DEFAULT_MODEL: str = "qwen2.5:14b-instruct-q8_0"

_MAX_MODEL_LENGTH = 128


class LLMSettings(BaseModel):
    """Public shape of the LLM-model setting.

    `model` is the literal Ollama model tag currently active (e.g.
    "qwen2.5:14b-instruct-q8_0", "gemma4:e4b") — no symbolic quality
    tier indirection.
    """

    model: str


class LLMSettingsUpdate(BaseModel):
    model: str

    @field_validator("model")
    @classmethod
    def _validate(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("model must not be empty")
        if len(v) > _MAX_MODEL_LENGTH:
            raise ValueError(f"model must be at most {_MAX_MODEL_LENGTH} characters")
        return v


class ActiveModelResponse(BaseModel):
    """Internal-endpoint response shape consumed by the auto-tagger.

    `ollama_model` is a wire contract already parsed verbatim by
    `auto_tagger.backend_provider._resolve_ollama_model` — keep this
    field name stable even as the public LLMSettings shape evolves.
    """

    ollama_model: str


class AvailableModelsResponse(BaseModel):
    """Locally-pulled Ollama model tags, for the Settings page picker.

    Always 200 with an (possibly empty) list — never an error response.
    Empty means either the backend isn't Ollama or Ollama didn't
    respond; the SPA falls back to manual text entry either way.
    """

    models: list[str]
