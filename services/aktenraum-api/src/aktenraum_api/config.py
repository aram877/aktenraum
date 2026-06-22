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
        True,
        description=(
            "Browser refuses to send the cookie over plain HTTP when true. "
            "Default true for safety; the localhost dev compose explicitly "
            "sets false in aktenraum-api.env so login works over http://."
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

    # Upload limits — applied per file in /api/documents/upload before
    # forwarding to Paperless. nginx's client_max_body_size caps the total
    # multipart payload at 100 MB by default; these limits clip each part
    # individually so one user can't upload 50 × 50 MB files in one go.
    upload_max_file_bytes: int = Field(
        25 * 1024 * 1024,
        ge=1,
        description="Per-file size cap in bytes (default 25 MB).",
    )
    upload_max_files_per_request: int = Field(
        20,
        ge=1,
        description="Maximum number of files accepted in one upload call.",
    )

    # Reprocess: aktenraum-api → auto-tagger webhook
    auto_tagger_url: str = Field(
        "http://auto-tagger:8001",
        description="Internal URL of the auto-tagger HTTP server (port 8001).",
    )
    webhook_secret: str = Field(
        "",
        description=(
            "Shared secret sent as `X-Aktenraum-Secret` to the auto-tagger's "
            "/trigger/extract. Must match auto-tagger's WEBHOOK_SECRET. Empty "
            "disables auth on both sides — fine for personal localhost."
        ),
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

    # RAG retrieval (Phase 1.8)
    qdrant_url: str = Field(
        "",
        description=(
            "Qdrant URL for query-time retrieval. The compose stack defaults "
            "this to http://qdrant:6333 (in-network); override only for "
            "development against a host-side qdrant. Empty disables RAG "
            "retrieval; the answer endpoint falls back to the structural-only "
            "path."
        ),
    )
    embedding_model: str = Field(
        "qwen3-embedding:4b",
        description=(
            "Ollama-served embedding model used to embed the user's query "
            "at retrieval time. Must match the model that produced the chunk "
            "embeddings during indexing — different models / dims cannot "
            "share a Qdrant collection. Its dimension must also match "
            "aktenraum_core.rag.DENSE_DIM (2560 for qwen3-embedding:4b)."
        ),
    )
    reranker_model: str = Field(
        "BAAI/bge-reranker-v2-m3",
        description=(
            "HuggingFace model id for the cross-encoder reranker. "
            "Loaded lazily on the first /ask request via "
            "sentence-transformers; first load downloads ~600 MB."
        ),
    )
    rag_retrieval_top_k: int = Field(
        50,
        ge=1,
        le=200,
        description=(
            "Top-K candidates fetched from Qdrant before reranking. "
            "Higher values help recall at the cost of reranker latency."
        ),
    )
    rag_rerank_top_k: int = Field(
        5,
        ge=1,
        le=50,
        description=(
            "Top-K candidates kept after reranking and fed into the answer "
            "LLM as document context."
        ),
    )
