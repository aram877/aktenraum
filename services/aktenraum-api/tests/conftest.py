"""Test wiring for aktenraum-api.

Each test gets a tempfile-backed SQLite (so all engines for the same test see
the same DB) and a fresh FastAPI app. Tests that exercise auth/bootstrap
override env-driven settings via the `client_factory` fixture.
"""

import os
import tempfile
from collections.abc import AsyncIterator, Callable

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import create_async_engine

from aktenraum_api.config import Settings
from aktenraum_api.db.models import Base
from aktenraum_api.main import create_app


@pytest.fixture
def settings_factory() -> Callable[..., Settings]:
    def _make(**overrides) -> Settings:
        defaults = {
            "JWT_SECRET": "test-secret-not-for-prod-32-bytes-min",
            "JWT_EXPIRES_SECONDS": 3600,
            "BOOTSTRAP_USERNAME": "",
            "BOOTSTRAP_PASSWORD": "",
            "COOKIE_SECURE": False,
        }
        defaults.update({k.upper(): v for k, v in overrides.items()})
        return Settings(**{k.lower(): v for k, v in defaults.items()})

    return _make


@pytest_asyncio.fixture
async def client_factory(settings_factory):
    """Yield an async factory that returns (app, settings, transport).

    Each call provisions its own tempfile SQLite, runs Base.metadata.create_all,
    and builds a fresh FastAPI app pointing at that DB. Lifespan must be entered
    by the test (so it can decide what state exists at bootstrap time).
    """
    paths_to_cleanup: list[str] = []

    async def _make(**setting_overrides):
        fd, path = tempfile.mkstemp(suffix=".db", prefix="aktenraum-test-")
        os.close(fd)
        paths_to_cleanup.append(path)
        db_url = f"sqlite+aiosqlite:///{path}"
        settings = settings_factory(DATABASE_URL=db_url, **setting_overrides)

        engine = create_async_engine(db_url, future=True)
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        await engine.dispose()

        app = create_app(settings)
        transport = ASGITransport(app=app)
        return app, settings, transport

    try:
        yield _make
    finally:
        for p in paths_to_cleanup:
            try:
                os.unlink(p)
            except FileNotFoundError:
                pass


@pytest_asyncio.fixture
async def client(client_factory) -> AsyncIterator[AsyncClient]:
    app, _settings, transport = await client_factory()
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
