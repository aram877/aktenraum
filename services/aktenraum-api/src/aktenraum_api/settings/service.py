"""DB-backed read/write of the singleton AppSettings row."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import AppSettings
from .quality import DEFAULT_QUALITY, QUALITY_TO_MODEL

_SINGLETON_ID = 1


async def get_row(session: AsyncSession) -> AppSettings:
    """Return the singleton settings row, creating it if missing.

    The migration seeds it, but defending against a fresh schema where
    the migration is rolled-back/incomplete keeps the API path robust."""
    row = await session.get(AppSettings, _SINGLETON_ID)
    if row is None:
        row = AppSettings(id=_SINGLETON_ID, llm_quality=DEFAULT_QUALITY)
        session.add(row)
        await session.commit()
        await session.refresh(row)
    return row


async def get_active_quality(session: AsyncSession) -> str:
    row = await get_row(session)
    return row.llm_quality


async def set_active_quality(session: AsyncSession, quality: str) -> AppSettings:
    if quality not in QUALITY_TO_MODEL:
        raise ValueError(
            f"Unknown quality '{quality}'. Must be one of: "
            + ", ".join(sorted(QUALITY_TO_MODEL))
        )
    row = await get_row(session)
    row.llm_quality = quality
    await session.commit()
    await session.refresh(row)
    return row


# Used by the latest-result query for the unauthenticated internal
# endpoint that the auto-tagger calls.
async def get_active_model(session: AsyncSession) -> str:
    quality = await get_active_quality(session)
    return QUALITY_TO_MODEL.get(quality, QUALITY_TO_MODEL[DEFAULT_QUALITY])


async def get_active_answer_quality(session: AsyncSession) -> str:
    row = await get_row(session)
    return row.answer_llm_quality


async def set_active_answer_quality(
    session: AsyncSession, quality: str
) -> AppSettings:
    if quality not in QUALITY_TO_MODEL:
        raise ValueError(
            f"Unknown quality '{quality}'. Must be one of: "
            + ", ".join(sorted(QUALITY_TO_MODEL))
        )
    row = await get_row(session)
    row.answer_llm_quality = quality
    await session.commit()
    await session.refresh(row)
    return row


async def get_active_answer_model(session: AsyncSession) -> str:
    quality = await get_active_answer_quality(session)
    return QUALITY_TO_MODEL.get(quality, QUALITY_TO_MODEL[DEFAULT_QUALITY])
