"""Tests for type-specific field extraction, schema API, and CRUD endpoints."""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from aktenraum_core.llm import build_type_specific_prompt
from aktenraum_core.models import TYPE_FIELD_SCHEMA, DocumentType
from httpx import AsyncClient

from aktenraum_api.ai.deps import get_paperless_gateway

FIELD_IDS = {
    "ai_document_type": 1,
    "ai_correspondent": 2,
    "ai_issue_date": 3,
    "ai_confidence": 10,
}


def _make_fake_gateway(doc_type: str = "Rechnung") -> AsyncMock:
    gw = AsyncMock()
    gw.get_document = AsyncMock(
        return_value={
            "id": 42,
            "title": "Test Rechnung",
            "created_date": "2024-01-15",
            "tags": [1],
            "custom_fields": [
                {"field": FIELD_IDS["ai_document_type"], "value": doc_type},
            ],
            "content": "some text",
        }
    )
    gw._get_custom_field_ids = AsyncMock(return_value={k: v for k, v in FIELD_IDS.items()})
    gw.list_tags = AsyncMock(return_value={"ai-pending": 1})
    gw.list_correspondents = AsyncMock(return_value={})
    gw.list_document_types = AsyncMock(return_value={})
    return gw


async def _login(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "topsecret"},
    )
    assert resp.status_code == 200, resp.text


async def _make_app(client_factory, gateway=None):
    app, _s, transport = await client_factory(
        BOOTSTRAP_USERNAME="admin",
        BOOTSTRAP_PASSWORD="topsecret",
        PAPERLESS_API_TOKEN="dummy",
    )
    if gateway is not None:
        app.dependency_overrides[get_paperless_gateway] = lambda: gateway
    return app, transport


# ---------------------------------------------------------------------------
# 8.1 — build_type_specific_prompt
# ---------------------------------------------------------------------------

def test_prompt_contains_correct_field_names_for_rechnung():
    prompt = build_type_specific_prompt(DocumentType.Rechnung, "text")
    for field in TYPE_FIELD_SCHEMA[DocumentType.Rechnung]:
        assert field.name in prompt


def test_prompt_does_not_contain_other_type_fields():
    prompt = build_type_specific_prompt(DocumentType.Rechnung, "text")
    assert "kennzeichen" not in prompt


def test_prompt_empty_for_sonstiges():
    assert build_type_specific_prompt(DocumentType.Sonstiges, "text") == ""


def test_prompt_contains_all_types():
    for doc_type, fields in TYPE_FIELD_SCHEMA.items():
        if not fields:
            continue
        prompt = build_type_specific_prompt(doc_type, "sample")
        for f in fields:
            assert f.name in prompt, f"{f.name} missing from {doc_type} prompt"


# ---------------------------------------------------------------------------
# 8.3 — GET /api/document-types/schema
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_schema_requires_auth(client_factory):
    app, transport = await _make_app(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/document-types/schema")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_schema_returns_all_types(client_factory):
    app, transport = await _make_app(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/document-types/schema")
    assert resp.status_code == 200
    body = resp.json()
    assert "Rechnung" in body
    assert "Sonstiges" in body
    assert body["Sonstiges"] == []
    rechnung_names = [f["name"] for f in body["Rechnung"]]
    assert "rechnungsnummer" in rechnung_names
    assert "mwst_satz" in rechnung_names


@pytest.mark.asyncio
async def test_schema_has_cache_header(client_factory):
    app, transport = await _make_app(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/document-types/schema")
    assert "private" in resp.headers.get("cache-control", "")
    assert "max-age=3600" in resp.headers.get("cache-control", "")


# ---------------------------------------------------------------------------
# 8.4 — GET + PATCH /api/documents/{id}/type-fields
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_type_fields_404_when_no_row(client_factory):
    gw = _make_fake_gateway()
    app, transport = await _make_app(client_factory, gateway=gw)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/42/type-fields")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_patch_type_fields_creates_row(client_factory):
    gw = _make_fake_gateway("Rechnung")
    app, transport = await _make_app(client_factory, gateway=gw)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.patch(
                "/api/documents/42/type-fields",
                json={"fields": {"rechnungsnummer": "RE-2024-001"}},
            )
    assert resp.status_code == 200
    body = resp.json()
    assert body["fields"]["rechnungsnummer"] == "RE-2024-001"
    assert body["document_type"] == "Rechnung"


@pytest.mark.asyncio
async def test_patch_type_fields_merges(client_factory):
    gw = _make_fake_gateway("Rechnung")
    app, transport = await _make_app(client_factory, gateway=gw)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            await c.patch(
                "/api/documents/42/type-fields",
                json={"fields": {"rechnungsnummer": "RE-001"}},
            )
            resp = await c.patch(
                "/api/documents/42/type-fields",
                json={"fields": {"iban": "DE89370400440532013000"}},
            )
    body = resp.json()
    assert body["fields"].get("rechnungsnummer") == "RE-001"
    assert body["fields"].get("iban") == "DE89370400440532013000"


@pytest.mark.asyncio
async def test_patch_unknown_field_rejected(client_factory):
    gw = _make_fake_gateway("Rechnung")
    app, transport = await _make_app(client_factory, gateway=gw)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.patch(
                "/api/documents/42/type-fields",
                json={"fields": {"kennzeichen": "B-AB 1234"}},
            )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_patch_money_field_normalised(client_factory):
    gw = _make_fake_gateway("Rechnung")
    app, transport = await _make_app(client_factory, gateway=gw)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.patch(
                "/api/documents/42/type-fields",
                json={"fields": {"nettobetrag": "42,00 EUR"}},
            )
    assert resp.status_code == 200
    body = resp.json()
    assert body["fields"]["nettobetrag"] == "EUR42.00"


# ---------------------------------------------------------------------------
# 8.5 — inbox detail includes type_fields key
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_inbox_detail_has_type_fields_null_when_no_row(client_factory):
    gw = _make_fake_gateway("Rechnung")
    app, transport = await _make_app(client_factory, gateway=gw)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/inbox/42")
    assert resp.status_code == 200
    body = resp.json()
    assert "type_fields" in body
    assert body["type_fields"] is None
