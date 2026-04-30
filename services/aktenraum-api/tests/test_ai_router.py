from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest
from aktenraum_core.models import DocumentType
from httpx import AsyncClient

from aktenraum_api.ai.deps import get_llm_backend, get_paperless_gateway
from aktenraum_api.ai.schemas import SearchFilter


class _FakeBackend:
    def __init__(self, returns: SearchFilter) -> None:
        self._returns = returns
        self.calls: list[list[dict]] = []

    async def complete(self, messages, response_schema):
        self.calls.append(messages)
        return self._returns

    @property
    def name(self) -> str:
        return "fake"

    @property
    def model(self) -> str:
        return "fake-model"


def _make_fake_gateway(
    *,
    correspondents: dict[str, int] | None = None,
    document_types: dict[str, int] | None = None,
    documents: list[dict] | None = None,
    monetary_field_id: int | None = None,
):
    gateway = AsyncMock()
    gateway.list_correspondents = AsyncMock(return_value=correspondents or {})
    gateway.list_document_types = AsyncMock(return_value=document_types or {})
    gateway.search_documents = AsyncMock(
        return_value={"results": documents or [], "count": len(documents or [])}
    )
    # Mimic the internal monetary-field-id cache the router pokes.
    gateway._monetary_field_id = monetary_field_id  # type: ignore[attr-defined]
    return gateway


async def _logged_in(client_factory, **overrides):
    app, settings, transport = await client_factory(
        BOOTSTRAP_USERNAME="admin",
        BOOTSTRAP_PASSWORD="topsecret",
        **overrides,
    )
    return app, settings, transport


async def _login(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "topsecret"},
    )
    assert resp.status_code == 200


async def test_ask_requires_auth(client_factory):
    app, _settings, transport = await _logged_in(
        client_factory, PAPERLESS_API_TOKEN="dummy"
    )
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post("/api/ai/ask", json={"query": "test"})
    assert resp.status_code == 401


async def test_ask_503_when_paperless_token_unset(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/ai/ask", json={"query": "test"})
    assert resp.status_code == 503
    assert "Paperless API token not configured" in resp.json()["detail"]


async def test_ask_query_branch_invokes_llm_and_returns_filter(client_factory):
    app, _settings, transport = await _logged_in(
        client_factory, PAPERLESS_API_TOKEN="dummy"
    )
    fake_filter = SearchFilter(
        document_type=DocumentType.Gehaltsabrechnung,
        date_from="2023-01-01",
        date_to="2023-12-31",
    )
    fake_backend = _FakeBackend(returns=fake_filter)
    fake_gateway = _make_fake_gateway(
        correspondents={"Telekom": 12},
        document_types={"Gehaltsabrechnung": 5},
        documents=[
            {
                "id": 1,
                "title": "Gehalt April 2023",
                "correspondent": 12,
                "document_type": 5,
                "created_date": "2023-04-15",
                "custom_fields": [],
            }
        ],
    )
    app.dependency_overrides[get_llm_backend] = lambda: fake_backend
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/ai/ask", json={"query": "Lohn aus 2023"}
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["filter"]["document_type"] == "Gehaltsabrechnung"
    assert body["filter"]["date_from"] == "2023-01-01"
    assert body["explanation"].startswith("Ich habe verstanden:")
    assert body["total"] == 1
    assert body["results"][0]["title"] == "Gehalt April 2023"
    assert fake_backend.calls, "LLM was not invoked on the query branch"


async def test_ask_filter_branch_skips_llm(client_factory):
    app, _settings, transport = await _logged_in(
        client_factory, PAPERLESS_API_TOKEN="dummy"
    )
    fake_backend = _FakeBackend(returns=SearchFilter())  # would explode if called
    fake_gateway = _make_fake_gateway(
        correspondents={}, document_types={"Rechnung": 1}, documents=[]
    )
    app.dependency_overrides[get_llm_backend] = lambda: fake_backend
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/ai/ask",
                json={"filter": {"document_type": "Rechnung"}},
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["filter"]["document_type"] == "Rechnung"
    assert body["results"] == []
    assert fake_backend.calls == [], "LLM must not be invoked on the filter branch"


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"query": None, "filter": None},
        {"query": "", "filter": None},
        {"query": "a", "filter": {"document_type": "Rechnung"}},
    ],
)
async def test_ask_validates_one_of(client_factory, payload: dict[str, Any]):
    app, _settings, transport = await _logged_in(
        client_factory, PAPERLESS_API_TOKEN="dummy"
    )
    app.dependency_overrides[get_paperless_gateway] = lambda: _make_fake_gateway()
    app.dependency_overrides[get_llm_backend] = lambda: _FakeBackend(returns=SearchFilter())

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/ai/ask", json=payload)

    assert resp.status_code == 422


async def test_ask_filter_with_unknown_doctype_is_422(client_factory):
    app, _settings, transport = await _logged_in(
        client_factory, PAPERLESS_API_TOKEN="dummy"
    )
    app.dependency_overrides[get_paperless_gateway] = lambda: _make_fake_gateway()
    app.dependency_overrides[get_llm_backend] = lambda: _FakeBackend(returns=SearchFilter())

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/ai/ask",
                json={"filter": {"document_type": "Banane"}},
            )

    assert resp.status_code == 422


async def test_ask_unknown_correspondent_falls_through_to_text(client_factory):
    app, _settings, transport = await _logged_in(
        client_factory, PAPERLESS_API_TOKEN="dummy"
    )
    fake_gateway = _make_fake_gateway(
        correspondents={"Telekom": 12},  # only Telekom is known
        document_types={},
        documents=[],
    )
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gateway
    app.dependency_overrides[get_llm_backend] = lambda: _FakeBackend(returns=SearchFilter())

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/ai/ask",
                json={"filter": {"correspondent": "Vodafone"}},
            )

    assert resp.status_code == 200
    fake_gateway.search_documents.assert_awaited()
    args, _ = fake_gateway.search_documents.await_args
    params = args[0]
    # Vodafone is unknown → no correspondent__id param; falls through to query=
    assert "correspondent__id" not in params
    assert params.get("query") == "Vodafone"
