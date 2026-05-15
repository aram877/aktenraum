"""Build the LLM backend on demand, honouring the runtime quality setting.

The auto-tagger used to build a single LLMBackend at startup from the
`OLLAMA_MODEL` env var. That meant flipping the model required a
container recreate. The SPA's Settings page now writes the active
quality to the aktenraum-api DB; this provider reads from there before
each extraction so the next doc uses the new model immediately.

Per-call HTTP round-trip cost is ~5 ms — negligible compared to the LLM
call itself (seconds). No caching, so the user gets the change as soon
as they click Save in the Settings page.

Anthropic isn't covered by the runtime picker — it stays on
ANTHROPIC_MODEL from the env. The quality picker is specifically about
local-model tradeoffs.
"""

from __future__ import annotations

import httpx
import structlog
from aktenraum_core.llm import LLMBackend, create_backend

from .config import Settings

log = structlog.get_logger()


async def build_active_backend(settings: Settings) -> LLMBackend:
    """Resolve the currently-selected model and return a fresh backend.

    For Ollama, the model name comes from
    `${AKTENRAUM_API_URL}/api/settings/active-llm-model` — a small
    unauthenticated endpoint reachable only from within the compose
    network. Fall back to the env's OLLAMA_MODEL if the api is
    unreachable so a misconfiguration never bricks extraction.
    """
    backend_name = settings.llm_backend.lower()
    if backend_name == "anthropic":
        return create_backend(
            "anthropic",
            anthropic_api_key=settings.anthropic_api_key or None,
            anthropic_model=settings.anthropic_model,
        )
    if backend_name == "ollama":
        model = await _resolve_ollama_model(settings)
        return create_backend(
            "ollama",
            ollama_base_url=settings.ollama_base_url,
            ollama_model=model,
        )
    # Fall through — let create_backend raise with the original name so
    # the operator sees the real error in logs.
    return create_backend(backend_name)


async def _resolve_ollama_model(settings: Settings) -> str:
    url = f"{settings.aktenraum_api_url.rstrip('/')}/api/settings/active-llm-model"
    headers: dict[str, str] = {}
    if settings.webhook_secret:
        headers["X-Aktenraum-Secret"] = settings.webhook_secret
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(url, headers=headers)
        if resp.status_code != 200:
            log.warning(
                "active_model_fetch_unexpected_status",
                status=resp.status_code,
                fallback=settings.ollama_model,
            )
            return settings.ollama_model
        body = resp.json()
        model = body.get("ollama_model")
        if not isinstance(model, str) or not model:
            log.warning(
                "active_model_fetch_empty",
                fallback=settings.ollama_model,
            )
            return settings.ollama_model
        return model
    except Exception as exc:
        log.info(
            "active_model_fetch_unreachable",
            error=str(exc),
            fallback=settings.ollama_model,
        )
        return settings.ollama_model
