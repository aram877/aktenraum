from collections.abc import AsyncIterator

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


def build_engine_and_sessionmaker(database_url: str):
    engine = create_async_engine(database_url, future=True)
    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)
    return engine, SessionLocal


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    """FastAPI dependency. The sessionmaker is set on app.state in create_app's lifespan."""
    SessionLocal = request.app.state.session_factory
    async with SessionLocal() as session:
        yield session
