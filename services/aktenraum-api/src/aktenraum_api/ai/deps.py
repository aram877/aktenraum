from __future__ import annotations

from aktenraum_core.llm import LLMBackend, create_backend
from fastapi import Depends, HTTPException, Request, status

from ..auth.deps import get_settings
from ..config import Settings
from ..paperless_gw import PaperlessGateway


def get_paperless_gateway(request: Request) -> PaperlessGateway:
    gateway: PaperlessGateway | None = getattr(
        request.app.state, "paperless_gateway", None
    )
    if gateway is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Paperless API token not configured",
        )
    return gateway


def get_llm_backend(settings: Settings = Depends(get_settings)) -> LLMBackend:
    """Build a fresh backend per request.

    Connection pooling is not needed at personal-DMS scale; if it ever is, the
    backend can move to app.state and be created once during lifespan.
    """
    backend = settings.llm_backend.lower()
    if backend == "anthropic":
        if not settings.anthropic_api_key:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="LLM backend 'anthropic' selected but ANTHROPIC_API_KEY is unset",
            )
        return create_backend(
            "anthropic",
            anthropic_api_key=settings.anthropic_api_key,
            anthropic_model=settings.anthropic_model,
        )
    if backend == "ollama":
        return create_backend(
            "ollama",
            ollama_base_url=settings.ollama_base_url,
            ollama_model=settings.ollama_model,
        )
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=f"Unknown LLM backend: {settings.llm_backend!r}",
    )
