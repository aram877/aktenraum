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
