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
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.deps import get_current_user, get_settings
from ..config import Settings
from ..db.models import User
from ..db.session import get_session
from . import service
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
    if settings.webhook_secret and x_aktenraum_secret != settings.webhook_secret:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Bad secret"
        )
    quality = await service.get_active_quality(session)
    return _to_response(quality)
