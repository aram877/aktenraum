from typing import Annotated

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # Paperless
    paperless_base_url: str = Field(
        ..., description="Base URL of Paperless instance, no trailing slash"
    )
    paperless_api_token: str = Field(..., description="Paperless REST API token")

    # LLM backend selection
    llm_backend: str = Field("anthropic", description="'anthropic' or 'ollama'")

    # Anthropic
    anthropic_api_key: str = Field(
        "", description="Anthropic API key (required when llm_backend=anthropic)"
    )
    anthropic_model: str = Field("claude-sonnet-4-6")

    # Ollama
    ollama_base_url: str = Field("http://localhost:11434")
    ollama_model: str = Field("llama3.1:8b")

    # Polling
    poll_interval_seconds: int = Field(30, ge=5)
    batch_size: int = Field(5, ge=1)

    # Propagation watcher — copies approved AI fields onto native Paperless
    # entities (correspondent, document_type, created_date, tags). Disable to
    # run extraction-only without writing to native fields.
    enable_propagation: bool = Field(True)

    # Confidence-based routing.
    #   AUTO_APPROVE_CONFIDENCE: minimum confidence to skip the human review
    #     queue and tag a doc ai-approved directly (the propagation loop then
    #     writes native fields automatically). Default 0.95 = strict.
    #   AUTO_APPROVE_TYPES: comma-separated DocumentType values eligible for
    #     auto-approve. Empty list (default) disables auto-approve for all
    #     types — opt in by adding routine, low-risk types like
    #     "Rechnung,Kontoauszug,Gehaltsabrechnung".
    #   LOW_CONFIDENCE_THRESHOLD: extractions below this confidence are tagged
    #     ai-low-confidence in addition to ai-pending so the user can
    #     prioritise them in the review queue.
    auto_approve_confidence: float = Field(0.95, ge=0.0, le=1.0)
    # NoDecode disables pydantic-settings's default JSON parsing so a plain
    # comma-separated env value ("Rechnung,Kontoauszug") is passed through to
    # the validator below.
    auto_approve_types: Annotated[list[str], NoDecode] = Field(default_factory=list)
    low_confidence_threshold: float = Field(0.6, ge=0.0, le=1.0)

    # Few-shot exemplars: when > 0, each extraction call prepends N recent
    # propagated documents (text excerpt + their AI extraction as JSON) to
    # the system prompt. Anchors the model to your real, user-vetted output
    # style. 0 disables. Each example is truncated to ~1500 chars; budget
    # roughly 500-700 tokens per example on top of the base prompt.
    few_shot_examples: int = Field(0, ge=0, le=5)

    @field_validator("auto_approve_types", mode="before")
    @classmethod
    def _split_csv(cls, v: object) -> object:
        if isinstance(v, str):
            return [s.strip() for s in v.split(",") if s.strip()]
        return v

    # Text processing
    max_tokens_input: int = Field(
        8000, ge=100, description="Approx token limit; text truncated at 4x chars"
    )

    # Logging
    log_level: str = Field("INFO")

    def validate_backend(self) -> None:
        if self.llm_backend == "anthropic" and not self.anthropic_api_key:
            raise ValueError("ANTHROPIC_API_KEY is required when LLM_BACKEND=anthropic")
        if self.llm_backend == "ollama" and not self.ollama_base_url:
            raise ValueError("OLLAMA_BASE_URL is required when LLM_BACKEND=ollama")
        if self.llm_backend not in ("anthropic", "ollama"):
            raise ValueError(
                f"Unknown LLM_BACKEND: {self.llm_backend!r}. Must be 'anthropic' or 'ollama'."
            )
