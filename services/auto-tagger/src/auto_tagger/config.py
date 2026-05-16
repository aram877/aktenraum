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
    #   AUTO_APPROVE_CONFIDENCE: minimum confidence to skip review and tag
    #     `ai-approved` directly. Default 0.90.
    #   AUTO_APPROVE_TYPES: hard allowlist on top of the confidence threshold.
    #     Both must be satisfied for a doc to auto-approve. Empty list disables
    #     auto-approve entirely — that's the secure default. Without this gate
    #     a prompt-injected PDF could emit confidence=0.99 and slip past review.
    #     Comma-separated env value: `AUTO_APPROVE_TYPES=Rechnung,Kontoauszug`.
    #   LOW_CONFIDENCE_THRESHOLD: extractions below this confidence are tagged
    #     ai-low-confidence in addition to ai-pending so the user can
    #     prioritise them in the review queue.
    auto_approve_confidence: float = Field(0.90, ge=0.0, le=1.0)
    auto_approve_types: Annotated[list[str], NoDecode] = Field(default_factory=list)
    low_confidence_threshold: float = Field(0.6, ge=0.0, le=1.0)

    # Few-shot exemplars: when > 0, each extraction call prepends N recent
    # propagated documents (text excerpt + their AI extraction as JSON) to
    # the system prompt. Anchors the model to your real, user-vetted output
    # style. 0 disables. Each example is truncated to ~1500 chars; budget
    # roughly 500-700 tokens per example on top of the base prompt.
    few_shot_examples: int = Field(0, ge=0, le=5)

    # Per-correspondent history hint: when true (default), each extraction
    # call checks whether the document's text mentions a known correspondent
    # from your `ai-propagated` corpus. If so, a hint is prepended to the
    # system prompt naming the dominant past document_type for that sender
    # (≥70% of ≥2 prior docs) or the full distribution otherwise. Drives
    # corpus-driven classification without retraining the model.
    use_correspondent_history: bool = Field(True)

    # HTTP webhook listener — Paperless's post_consume_script POSTs the
    # document id here so extraction starts within seconds instead of waiting
    # for the next 30s poll cycle. The poller still runs as a safety net for
    # missed events (auto-tagger restart, network blip, paperless workflow
    # not yet wired). Disable to run polling-only.
    enable_http_server: bool = Field(True)
    http_port: int = Field(8001, ge=1, le=65535)
    # Optional shared secret. When set, requests must carry the same value
    # in `X-Aktenraum-Secret`; missing/wrong header → 401. Empty disables
    # auth (fine for the default localhost-only / internal-network setup).
    webhook_secret: str = Field("")

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

    # RAG indexing (Phase 1)
    # When `qdrant_url` is empty (default), the indexer worker is not
    # started, the propagator does not enqueue, and the extraction +
    # propagation path stays untouched. Set both `qdrant_url` and
    # `embedding_model` to enable indexing.
    qdrant_url: str = Field("")
    embedding_model: str = Field("bge-m3")

    # aktenraum-api URL for writing type-specific fields (pass 2)
    aktenraum_api_url: str = Field("http://aktenraum-api:8002")

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
