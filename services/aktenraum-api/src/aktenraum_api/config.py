from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    database_url: str = Field(
        ...,
        description=(
            "Async SQLAlchemy URL. Production: postgresql+asyncpg://.../aktenraum. "
            "Tests override to sqlite+aiosqlite://"
        ),
    )

    # JWT signing. No default — refuse to start without it.
    jwt_secret: str = Field(
        ...,
        description="HS256 signing key. Generate with `openssl rand -base64 32`.",
    )
    jwt_expires_seconds: int = Field(28800, ge=60, description="Cookie + JWT lifetime")

    # Auth cookie
    cookie_name: str = Field("aktenraum_session")
    cookie_secure: bool = Field(
        False,
        description=(
            "Set true behind HTTPS so the browser refuses to send the cookie over plain HTTP."
        ),
    )

    # First-startup user seed
    bootstrap_username: str = Field(
        "",
        description=(
            "Created on first start if the users table is empty. Ignored once any user exists."
        ),
    )
    bootstrap_password: str = Field("")

    log_level: str = Field("INFO")

    # Paperless gateway (server-side, never reaches the SPA).
    paperless_base_url: str = Field(
        "http://paperless:8000",
        description="Internal Paperless URL the API container reaches. Override per deploy.",
    )
    paperless_api_token: str = Field(
        "",
        description=(
            "Paperless API token. Required for /api/ai/* endpoints. "
            "When empty, AI endpoints respond 503; auth + health stay green."
        ),
    )
    correspondent_list_ttl_seconds: int = Field(
        300, ge=1, description="Per-process correspondent cache TTL"
    )

    # LLM backend selection — same env knob the auto-tagger uses.
    llm_backend: str = Field(
        "anthropic",
        description="anthropic | ollama",
    )
    anthropic_api_key: str = Field("", description="Required when LLM_BACKEND=anthropic")
    anthropic_model: str = Field("claude-sonnet-4-6")
    anthropic_answer_model: str = Field(
        "",
        description=(
            "Model used for the conversational answer step (POST /api/ai/answer). "
            "Falls back to anthropic_model when empty. Use a stronger model here "
            "if the default is too cheap to reason over the citations."
        ),
    )
    ollama_base_url: str = Field("http://host.docker.internal:11434")
    ollama_model: str = Field("llama3.1:8b")
    ollama_answer_model: str = Field(
        "",
        description=(
            "Model used for the conversational answer step. Falls back to "
            "ollama_model when empty. Recommended: a 14B+ class model so it "
            "can reliably read structured fields and cite by id."
        ),
    )
