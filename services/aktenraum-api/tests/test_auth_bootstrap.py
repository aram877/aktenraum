from sqlalchemy import select

from aktenraum_api.auth.passwords import verify_password
from aktenraum_api.db.models import User


async def test_bootstrap_creates_single_user_on_empty_db(client_factory):
    app, _settings, _transport = await client_factory(
        BOOTSTRAP_USERNAME="admin", BOOTSTRAP_PASSWORD="changeme"
    )
    async with app.router.lifespan_context(app):
        SessionLocal = app.state.session_factory
        async with SessionLocal() as session:
            users = (await session.scalars(select(User))).all()
    assert len(users) == 1
    assert users[0].username == "admin"
    assert verify_password("changeme", users[0].password_hash)


async def test_bootstrap_skips_when_user_already_exists(client_factory):
    app, settings, _transport = await client_factory(
        BOOTSTRAP_USERNAME="first", BOOTSTRAP_PASSWORD="pw1"
    )
    async with app.router.lifespan_context(app):
        SessionLocal = app.state.session_factory
        async with SessionLocal() as session:
            first_user = await session.scalar(select(User).limit(1))
        assert first_user is not None and first_user.username == "first"

    # Re-run lifespan with different creds — must not change anything.
    settings.bootstrap_username = "second"
    settings.bootstrap_password = "pw2"
    async with app.router.lifespan_context(app):
        SessionLocal = app.state.session_factory
        async with SessionLocal() as session:
            users = (await session.scalars(select(User))).all()
    assert len(users) == 1
    assert users[0].username == "first"


async def test_bootstrap_skips_when_creds_missing(client_factory):
    app, _settings, _transport = await client_factory()
    async with app.router.lifespan_context(app):
        SessionLocal = app.state.session_factory
        async with SessionLocal() as session:
            users = (await session.scalars(select(User))).all()
    assert users == []
