"""Settings endpoints.

`GET /api/settings/llm` and `PATCH /api/settings/llm` are auth-gated —
the SPA's Settings page consumes them.

`GET /api/settings/active-llm-model` is **unauthenticated** on purpose:
the auto-tagger runs inside the compose network and calls this before
each extraction to pick up the operator's choice. Port 8002 is not
published to the host, so this endpoint is only reachable from inside
the network. We add the WEBHOOK_SECRET check on top when set, for
defence-in-depth in installations that DO expose the api beyond
localhost.

`GET /api/settings/auto-approve` + `PUT /api/settings/auto-approve` are
auth-gated and edit the per-DocumentType rule table. The internal
endpoint `GET /api/settings/active-auto-approve-rules` mirrors the
LLM internal-endpoint pattern — secret-gated, consumed by the
auto-tagger with a 60s TTL cache.
"""

from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.deps import get_current_user, get_settings
from ..config import Settings
from ..db.models import User
from ..db.session import get_session
from . import auto_approve_service, service
from .auto_approve_schemas import (
    AutoApproveRulesResponse,
    AutoApproveRulesUpdateRequest,
)
from ollama import AsyncClient as OllamaAsyncClient

from .schemas import (
    ActiveModelResponse,
    AvailableModelsResponse,
    LLMSettings,
    LLMSettingsUpdate,
)

router = APIRouter(prefix="/settings", tags=["settings"])

_OLLAMA_LIST_TIMEOUT_SECONDS = 3.0


@router.get("/llm", response_model=LLMSettings)
async def get_llm_settings(
    _user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> LLMSettings:
    model = await service.get_active_model(session)
    return LLMSettings(model=model)


@router.patch("/llm", response_model=LLMSettings)
async def update_llm_settings(
    body: LLMSettingsUpdate,
    _user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> LLMSettings:
    row = await service.set_active_model(session, body.model)
    return LLMSettings(model=row.llm_model)


@router.get("/answer-llm", response_model=LLMSettings)
async def get_answer_llm_settings(
    _user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> LLMSettings:
    model = await service.get_active_answer_model(session)
    return LLMSettings(model=model)


@router.patch("/answer-llm", response_model=LLMSettings)
async def update_answer_llm_settings(
    body: LLMSettingsUpdate,
    _user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> LLMSettings:
    row = await service.set_active_answer_model(session, body.model)
    return LLMSettings(model=row.answer_llm_model)


@router.get("/available-models", response_model=AvailableModelsResponse)
async def get_available_models(
    _user: User = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> AvailableModelsResponse:
    """Locally-pulled Ollama model tags, for the Settings page picker.

    Always returns 200. An empty list means either the backend isn't
    Ollama or Ollama didn't respond in time — the SPA falls back to
    manual model-tag entry in both cases rather than surfacing an
    error for what's often a transient condition.
    """
    if settings.llm_backend.lower() != "ollama":
        return AvailableModelsResponse(models=[])
    try:
        client = OllamaAsyncClient(
            host=settings.ollama_base_url, timeout=_OLLAMA_LIST_TIMEOUT_SECONDS
        )
        response = await client.list()
    except Exception:
        return AvailableModelsResponse(models=[])
    tags = [m.model for m in response.models if m.model]
    return AvailableModelsResponse(models=tags)


@router.get("/active-llm-model", response_model=ActiveModelResponse)
async def get_active_llm_model_internal(
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
    x_aktenraum_secret: str | None = Header(default=None, alias="X-Aktenraum-Secret"),
) -> ActiveModelResponse:
    """Auto-tagger reads the active model from here before each
    extraction. Authless by design (in-network only); if
    WEBHOOK_SECRET is configured, the header must match."""
    if settings.webhook_secret:
        if x_aktenraum_secret is None or not hmac.compare_digest(
            x_aktenraum_secret, settings.webhook_secret
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Bad secret"
            )
    model = await service.get_active_model(session)
    return ActiveModelResponse(ollama_model=model)


@router.get("/auto-approve", response_model=AutoApproveRulesResponse)
async def get_auto_approve_rules(
    _user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> AutoApproveRulesResponse:
    rules = await auto_approve_service.list_rules(session)
    return AutoApproveRulesResponse(rules=rules)


@router.put("/auto-approve", response_model=AutoApproveRulesResponse)
async def update_auto_approve_rules(
    body: AutoApproveRulesUpdateRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> AutoApproveRulesResponse:
    rules = await auto_approve_service.replace_rules(
        session, body, updated_by=user.username
    )
    return AutoApproveRulesResponse(rules=rules)


@router.get(
    "/active-auto-approve-rules", response_model=AutoApproveRulesResponse
)
async def get_active_auto_approve_rules_internal(
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
    x_aktenraum_secret: str | None = Header(default=None, alias="X-Aktenraum-Secret"),
) -> AutoApproveRulesResponse:
    """Auto-tagger reads the per-type rules from here before each
    routing decision. Authless by design (in-network only); if
    WEBHOOK_SECRET is configured, the header must match."""
    if settings.webhook_secret:
        if x_aktenraum_secret is None or not hmac.compare_digest(
            x_aktenraum_secret, settings.webhook_secret
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Bad secret"
            )
    rules = await auto_approve_service.list_rules(session)
    return AutoApproveRulesResponse(rules=rules)
