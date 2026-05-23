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
from .quality import QUALITY_TO_MODEL
from .schemas import LLMSettings, LLMSettingsUpdate

router = APIRouter(prefix="/settings", tags=["settings"])


def _to_response(quality: str) -> LLMSettings:
    return LLMSettings(quality=quality, ollama_model=QUALITY_TO_MODEL[quality])


@router.get("/llm", response_model=LLMSettings)
async def get_llm_settings(
    _user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> LLMSettings:
    quality = await service.get_active_quality(session)
    return _to_response(quality)


@router.patch("/llm", response_model=LLMSettings)
async def update_llm_settings(
    body: LLMSettingsUpdate,
    _user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> LLMSettings:
    row = await service.set_active_quality(session, body.quality)
    return _to_response(row.llm_quality)


@router.get("/answer-llm", response_model=LLMSettings)
async def get_answer_llm_settings(
    _user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> LLMSettings:
    quality = await service.get_active_answer_quality(session)
    return _to_response(quality)


@router.patch("/answer-llm", response_model=LLMSettings)
async def update_answer_llm_settings(
    body: LLMSettingsUpdate,
    _user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> LLMSettings:
    row = await service.set_active_answer_quality(session, body.quality)
    return _to_response(row.answer_llm_quality)


@router.get("/active-llm-model", response_model=LLMSettings)
async def get_active_llm_model_internal(
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
    x_aktenraum_secret: str | None = Header(default=None, alias="X-Aktenraum-Secret"),
) -> LLMSettings:
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
    quality = await service.get_active_quality(session)
    return _to_response(quality)


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
