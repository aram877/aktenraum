"""Smoke tests for the /api/settings endpoints + the active-model helper."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from httpx import AsyncClient


async def _logged_in_client(client_factory, **overrides):
    app, settings, transport = await client_factory(
        BOOTSTRAP_USERNAME="admin", BOOTSTRAP_PASSWORD="topsecret", **overrides
    )
    return app, settings, transport


async def _login(c: AsyncClient) -> None:
    resp = await c.post(
        "/api/auth/login",
        json={"username": "admin", "password": "topsecret"},
    )
    assert resp.status_code == 200, resp.text


async def test_get_returns_default_on_fresh_db(client_factory):
    app, _s, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/settings/llm")
    assert resp.status_code == 200
    assert resp.json() == {"model": "qwen2.5:14b-instruct-q8_0"}


async def test_patch_to_arbitrary_model_persists(client_factory):
    app, _s, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.patch("/api/settings/llm", json={"model": "gemma4:e4b"})
            assert resp.status_code == 200
            assert resp.json() == {"model": "gemma4:e4b"}
            # Second GET reflects the persisted choice.
            resp = await c.get("/api/settings/llm")
    assert resp.json() == {"model": "gemma4:e4b"}


async def test_answer_model_is_independent_of_extraction_model(client_factory):
    app, _s, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            await c.patch("/api/settings/llm", json={"model": "gemma4:e4b"})
            await c.patch(
                "/api/settings/answer-llm", json={"model": "qwen2.5:32b-instruct"}
            )
            llm_resp = await c.get("/api/settings/llm")
            answer_resp = await c.get("/api/settings/answer-llm")
    assert llm_resp.json() == {"model": "gemma4:e4b"}
    assert answer_resp.json() == {"model": "qwen2.5:32b-instruct"}


async def test_patch_empty_model_rejected(client_factory):
    app, _s, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.patch("/api/settings/llm", json={"model": ""})
    assert resp.status_code == 422


async def test_patch_overlong_model_rejected(client_factory):
    app, _s, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.patch("/api/settings/llm", json={"model": "x" * 129})
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
    assert body == {"ollama_model": "qwen2.5:14b-instruct-q8_0"}


async def test_active_llm_model_reflects_saved_choice(client_factory):
    app, _s, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            await c.patch("/api/settings/llm", json={"model": "gemma4:e4b"})
            resp = await c.get("/api/settings/active-llm-model")
    assert resp.json() == {"ollama_model": "gemma4:e4b"}


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


async def test_available_models_empty_when_backend_is_anthropic(client_factory):
    app, _s, transport = await _logged_in_client(client_factory, LLM_BACKEND="anthropic")
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/settings/available-models")
    assert resp.status_code == 200
    assert resp.json() == {"models": []}


async def test_available_models_lists_pulled_tags(client_factory):
    app, _s, transport = await _logged_in_client(client_factory, LLM_BACKEND="ollama")

    class _FakeModel:
        def __init__(self, model: str) -> None:
            self.model = model

    class _FakeListResponse:
        def __init__(self, tags: list[str]) -> None:
            self.models = [_FakeModel(t) for t in tags]

    with patch(
        "aktenraum_api.settings.router.OllamaAsyncClient"
    ) as mock_client_cls:
        mock_client_cls.return_value.list = AsyncMock(
            return_value=_FakeListResponse(["qwen2.5:14b-instruct-q8_0", "gemma4:e4b"])
        )
        async with app.router.lifespan_context(app):
            async with AsyncClient(transport=transport, base_url="http://test") as c:
                await _login(c)
                resp = await c.get("/api/settings/available-models")
    assert resp.status_code == 200
    assert resp.json() == {"models": ["qwen2.5:14b-instruct-q8_0", "gemma4:e4b"]}


async def test_available_models_empty_when_ollama_unreachable(client_factory):
    app, _s, transport = await _logged_in_client(client_factory, LLM_BACKEND="ollama")

    with patch(
        "aktenraum_api.settings.router.OllamaAsyncClient"
    ) as mock_client_cls:
        mock_client_cls.return_value.list = AsyncMock(
            side_effect=ConnectionError("no route to host")
        )
        async with app.router.lifespan_context(app):
            async with AsyncClient(transport=transport, base_url="http://test") as c:
                await _login(c)
                resp = await c.get("/api/settings/available-models")
    assert resp.status_code == 200
    assert resp.json() == {"models": []}


async def test_available_models_requires_auth(client_factory):
    app, _s, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/settings/available-models")
    assert resp.status_code == 401
