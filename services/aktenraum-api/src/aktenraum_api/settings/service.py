"""DB-backed read/write of the singleton AppSettings row."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import AppSettings
from .schemas import DEFAULT_MODEL

_SINGLETON_ID = 1


async def get_row(session: AsyncSession) -> AppSettings:
    """Return the singleton settings row, creating it if missing.

    The migration seeds it, but defending against a fresh schema where
    the migration is rolled-back/incomplete keeps the API path robust."""
    row = await session.get(AppSettings, _SINGLETON_ID)
    if row is None:
        row = AppSettings(id=_SINGLETON_ID, llm_model=DEFAULT_MODEL)
        session.add(row)
        await session.commit()
        await session.refresh(row)
    return row


async def get_active_model(session: AsyncSession) -> str:
    row = await get_row(session)
    return row.llm_model


async def set_active_model(session: AsyncSession, model: str) -> AppSettings:
    row = await get_row(session)
    row.llm_model = model
    await session.commit()
    await session.refresh(row)
    return row


async def get_active_answer_model(session: AsyncSession) -> str:
    row = await get_row(session)
    return row.answer_llm_model


async def set_active_answer_model(session: AsyncSession, model: str) -> AppSettings:
    row = await get_row(session)
    row.answer_llm_model = model
    await session.commit()
    await session.refresh(row)
    return row
