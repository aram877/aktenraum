"""Tests for the doc-detail + field-patch endpoints used by the Library
detail page (/library/$id). These mirror the inbox endpoints' behaviour but
work on any document, not just pending ones.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

from httpx import AsyncClient

from aktenraum_api.ai.deps import get_paperless_gateway
from aktenraum_api.paperless_gw import PaperlessAuthError, PaperlessNotFoundError

FIELD_IDS = {
    "ai_document_type": 1,
    "ai_correspondent": 2,
    "ai_title": 3,
    "ai_issue_date": 4,
    "ai_reference_numbers": 7,
    "ai_suggested_tags": 8,
    "ai_summary_de": 9,
    "ai_confidence": 10,
    "ai_backend": 11,
    "ai_model": 12,
}

TAG_IDS = {
    "ai-pending": 1,
    "ai-approved": 2,
    "ai-rejected": 3,
    "ai-propagated": 4,
    "ai-low-confidence": 7,
    "ai-auto-approved": 8,
}


def _doc(
    doc_id: int,
    *,
    title: str = "Doc",
    tags: list[int] | None = None,
    custom_fields: list[dict] | None = None,
):
    return {
        "id": doc_id,
        "title": title,
        "correspondent": None,
        "document_type": None,
        "created_date": "2024-01-15",
        "tags": tags or [TAG_IDS["ai-propagated"]],
        "custom_fields": custom_fields or [],
        "content": "",
    }


def _make_gateway(*, doc: dict | None = None):
    gw = AsyncMock()
    gw.list_tags = AsyncMock(return_value=dict(TAG_IDS))
    gw._get_custom_field_ids = AsyncMock(return_value=dict(FIELD_IDS))

    async def _get(doc_id):
        if doc is None or doc["id"] != doc_id:
            raise PaperlessNotFoundError(doc_id)
        return doc

    gw.get_document = AsyncMock(side_effect=_get)
    gw.patch_document_custom_fields = AsyncMock(
        side_effect=lambda doc_id, kv, **_kw: kv,
    )
    return gw


async def _logged_in(client_factory):
    return await client_factory(
        BOOTSTRAP_USERNAME="admin",
        BOOTSTRAP_PASSWORD="topsecret",
        PAPERLESS_API_TOKEN="dummy",
    )


async def _login(c: AsyncClient) -> None:
    resp = await c.post(
        "/api/auth/login", json={"username": "admin", "password": "topsecret"}
    )
    assert resp.status_code == 200


# ---- GET /api/documents/{id}/detail ----


async def test_detail_requires_auth(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/documents/9/detail")
    assert resp.status_code == 401


async def test_detail_returns_full_inboxdetail_shape_for_propagated_doc(client_factory):
    """The endpoint must work on any doc, not just pending — that's the whole
    reason for adding it (the inbox endpoint name was misleading callers).
    """
    app, _settings, transport = await _logged_in(client_factory)
    doc = _doc(
        9,
        title="Cursor Rechnung",
        tags=[TAG_IDS["ai-propagated"]],  # NOT pending
        custom_fields=[
            {"field": FIELD_IDS["ai_document_type"], "value": "Rechnung"},
            {"field": FIELD_IDS["ai_correspondent"], "value": "Cursor Bill to"},
            {"field": FIELD_IDS["ai_summary_de"], "value": "Eine Rechnung."},
        ],
    )
    gw = _make_gateway(doc=doc)
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/9/detail")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["id"] == 9
    assert body["ai_document_type"] == "Rechnung"
    assert body["ai_correspondent"] == "Cursor Bill to"
    assert body["ai_summary_de"] == "Eine Rechnung."
    assert "ai-propagated" in body["tags"]


async def test_detail_404_for_missing_doc(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gw = _make_gateway(doc=None)
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/9999/detail")

    assert resp.status_code == 404


async def test_detail_502_on_paperless_auth_error(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gw = _make_gateway(doc=None)
    gw.get_document = AsyncMock(side_effect=PaperlessAuthError(401))
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/9/detail")

    assert resp.status_code == 502


# ---- PATCH /api/documents/{id}/fields ----


async def test_patch_fields_requires_auth(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.patch("/api/documents/9/fields", json={})
    assert resp.status_code == 401


async def test_patch_fields_calls_gateway_with_supplied_fields(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    doc = _doc(9)
    gw = _make_gateway(doc=doc)
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.patch(
                "/api/documents/9/fields",
                json={"ai_correspondent": "Acme GmbH"},
            )

    assert resp.status_code == 200
    gw.patch_document_custom_fields.assert_awaited_once()
    call = gw.patch_document_custom_fields.await_args
    assert call.args[0] == 9
    assert call.args[1] == {"ai_correspondent": "Acme GmbH"}
    # apply_field_update prefetches the doc once to avoid the gateway's
    # internal merge-read — assert the dict is forwarded as `prefetched_doc`.
    assert "prefetched_doc" in call.kwargs


async def test_patch_fields_empty_body_is_noop(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    doc = _doc(9)
    gw = _make_gateway(doc=doc)
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.patch("/api/documents/9/fields", json={})

    assert resp.status_code == 200
    gw.patch_document_custom_fields.assert_not_awaited()


async def test_patch_fields_404_for_missing_doc(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gw = _make_gateway(doc=None)
    gw.patch_document_custom_fields = AsyncMock(
        side_effect=PaperlessNotFoundError(9999),
    )
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.patch(
                "/api/documents/9999/fields",
                json={"ai_correspondent": "X"},
            )

    assert resp.status_code == 404
