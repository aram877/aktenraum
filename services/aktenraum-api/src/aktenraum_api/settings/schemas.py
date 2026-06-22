from __future__ import annotations

from pydantic import BaseModel, field_validator

from .quality import QUALITY_TO_MODEL


class LLMSettings(BaseModel):
    """Public shape of the LLM-quality setting.

    `quality` is the symbolic label the SPA renders ("high" / "medium").
    `ollama_model` is the resolved Ollama tag, surfaced so the SPA can
    show the resolved model name (e.g. qwen2.5:14b-instruct-q8_0) without duplicating the mapping.
    """

    quality: str
    ollama_model: str


class LLMSettingsUpdate(BaseModel):
    quality: str

    @field_validator("quality")
    @classmethod
    def _validate(cls, v: str) -> str:
        if v not in QUALITY_TO_MODEL:
            raise ValueError(
                f"Unknown quality '{v}'. Must be one of: "
                + ", ".join(sorted(QUALITY_TO_MODEL))
            )
        return v
