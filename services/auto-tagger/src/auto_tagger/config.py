from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Paperless
    paperless_base_url: str = Field(..., description="Base URL of Paperless instance, no trailing slash")
    paperless_api_token: str = Field(..., description="Paperless REST API token")

    # LLM backend selection
    llm_backend: str = Field("anthropic", description="'anthropic' or 'ollama'")

    # Anthropic
    anthropic_api_key: str = Field("", description="Anthropic API key (required when llm_backend=anthropic)")
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

    # Text processing
    max_tokens_input: int = Field(8000, ge=100, description="Approx token limit; text truncated at 4x chars")

    # Logging
    log_level: str = Field("INFO")

    def validate_backend(self) -> None:
        if self.llm_backend == "anthropic" and not self.anthropic_api_key:
            raise ValueError("ANTHROPIC_API_KEY is required when LLM_BACKEND=anthropic")
        if self.llm_backend == "ollama" and not self.ollama_base_url:
            raise ValueError("OLLAMA_BASE_URL is required when LLM_BACKEND=ollama")
        if self.llm_backend not in ("anthropic", "ollama"):
            raise ValueError(f"Unknown LLM_BACKEND: {self.llm_backend!r}. Must be 'anthropic' or 'ollama'.")
