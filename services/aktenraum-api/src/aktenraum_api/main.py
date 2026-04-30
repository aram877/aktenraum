import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI

from .auth import bootstrap_user_if_empty
from .auth import router as auth_router
from .config import Settings
from .db.session import build_engine_and_sessionmaker
from .health import router as health_router


def _configure_logging(level: str) -> None:
    structlog.configure(
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelName(level)),
        processors=[
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.add_log_level,
            structlog.processors.JSONRenderer(),
        ],
    )


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    _configure_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine, SessionLocal = build_engine_and_sessionmaker(settings.database_url)
        app.state.engine = engine
        app.state.session_factory = SessionLocal
        async with SessionLocal() as session:
            await bootstrap_user_if_empty(
                session,
                username=settings.bootstrap_username,
                password=settings.bootstrap_password,
            )
        yield
        await engine.dispose()

    app = FastAPI(
        title="aktenraum-api",
        version="0.1.0",
        openapi_url="/api/openapi.json",
        docs_url="/api/docs",
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.include_router(health_router, prefix="/api")
    app.include_router(auth_router, prefix="/api")
    return app
