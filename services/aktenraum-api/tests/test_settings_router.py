"""Smoke tests for the /api/settings endpoints + the active-model helper."""

from __future__ import annotations

from httpx import AsyncClient


async def _logged_in_client(client_factory):
    app, settings, transport = await client_factory(
        BOOTSTRAP_USERNAME="admin", BOOTSTRAP_PASSWORD="topsecret"
    )
    return app, settings, transport


async def _login(c: AsyncClient) -> None:
    resp = await c.post(
        "/api/auth/login",
        json={"username": "admin", "password": "topsecret"},
    )
    assert resp.status_code == 200, resp.text


async def test_get_returns_high_default_on_fresh_db(client_factory):
    app, _s, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/settings/llm")
    assert resp.status_code == 200
    body = resp.json()
    # `high` is the seeded default; the resolver maps it to gemma4:26b.
    assert body == {"quality": "high", "ollama_model": "gemma4:26b"}


async def test_patch_to_medium_persists(client_factory):
    app, _s, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.patch(
                "/api/settings/llm", json={"quality": "medium"}
            )
            assert resp.status_code == 200
            assert resp.json() == {
                "quality": "medium",
                "ollama_model": "gemma4:e4b",
            }
            # Second GET reflects the persisted choice.
            resp = await c.get("/api/settings/llm")
    assert resp.json()["quality"] == "medium"


async def test_patch_unknown_quality_rejected(client_factory):
    app, _s, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.patch(
                "/api/settings/llm", json={"quality": "ultra"}
            )
    assert resp.status_code == 422


async def test_get_requires_auth(client_factory):
    app, _s, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/settings/llm")
    assert resp.status_code == 401


async def test_active_llm_model_is_unauthenticated(client_factory):
    """The auto-tagger calls this without a session cookie. In-network
    only by deployment shape; no auth header required when
    WEBHOOK_SECRET is unset."""
    app, _s, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            # No login.
            resp = await c.get("/api/settings/active-llm-model")
    assert resp.status_code == 200
    body = resp.json()
    assert body["quality"] in ("high", "medium")
    assert body["ollama_model"]


async def test_active_llm_model_rejects_bad_secret(client_factory):
    app, _s, transport = await _logged_in_client(client_factory)
    # When WEBHOOK_SECRET is configured, the helper must demand a match.
    settings = _s
    settings.webhook_secret = "topsecret"
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get(
                "/api/settings/active-llm-model",
                headers={"X-Aktenraum-Secret": "wrong"},
            )
    assert resp.status_code == 401
