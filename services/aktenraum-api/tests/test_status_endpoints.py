"""Tests for the upload-pipeline visibility endpoints:
- GET /api/documents/in-flight (Nav badge data source)
- GET /api/documents/task/{uuid} (Paperless consumer task lookup)
- GET /api/documents/{id}/status (lightweight lifecycle-tag lookup)
"""

from __future__ import annotations

import importlib
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import AsyncClient

from aktenraum_api.ai.deps import get_paperless_gateway
from aktenraum_api.paperless_gw import PaperlessAuthError, PaperlessNotFoundError

# The `documents/__init__.py` re-exports the APIRouter under the same name as
# the submodule, so `import aktenraum_api.documents.router` actually resolves
# to the APIRouter. `importlib` gives us the real module object whose
# `_in_flight_cache` we need to reset between tests.
_router_module = importlib.import_module("aktenraum_api.documents.router")


@pytest.fixture(autouse=True)
def _reset_in_flight_cache():
    """The /in-flight endpoint memoises its result for 15s at module scope.
    Without this reset, the first test's count leaks into later tests."""
    _router_module._in_flight_cache = None
    yield
    _router_module._in_flight_cache = None

TAG_IDS = {
    "ai-pending": 1,
    "ai-approved": 2,
    "ai-rejected": 3,
    "ai-propagated": 4,
    "ai-propagation-error": 5,
    "ai-error": 6,
    "ai-low-confidence": 7,
    "sonstiges": 99,
}


def _make_gateway(*, tags: dict[str, int] | None = None):
    gw = AsyncMock()
    gw.list_tags = AsyncMock(return_value=tags if tags is not None else dict(TAG_IDS))
    gw.search_documents = AsyncMock(return_value={"results": [], "count": 0})
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


# ---- /api/documents/in-flight ----


async def test_in_flight_requires_auth(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/documents/in-flight")
    assert resp.status_code == 401


async def test_in_flight_counts_pending_plus_approved(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gw = _make_gateway()
    gw.search_documents = AsyncMock(return_value={"results": [], "count": 7})
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/in-flight")

    assert resp.status_code == 200
    body = resp.json()
    assert body == {"count": 7}
    sent = gw.search_documents.await_args.args[0]
    # tags__id__in is a comma-separated list with both in-flight tag ids.
    in_flight_ids = sorted(int(x) for x in sent["tags__id__in"].split(","))
    assert in_flight_ids == sorted([TAG_IDS["ai-pending"], TAG_IDS["ai-approved"]])


async def test_in_flight_zero_when_lifecycle_tags_absent(client_factory):
    """Fresh installs without the lifecycle taxonomy yet: count=0, no query."""
    app, _settings, transport = await _logged_in(client_factory)
    gw = _make_gateway(tags={})
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/in-flight")

    assert resp.status_code == 200
    assert resp.json() == {"count": 0}
    gw.search_documents.assert_not_awaited()


# ---- /api/documents/task/{uuid} ----


async def test_task_status_success_extracts_doc_id_from_related_document(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gw = _make_gateway()

    fake_resp = MagicMock()
    fake_resp.status_code = 200
    fake_resp.json = MagicMock(return_value=[
        {
            "task_id": "abc",
            "status": "SUCCESS",
            "result": "Success. New document id 42 created",
            "related_document": 42,
        }
    ])
    fake_resp.raise_for_status = MagicMock()
    gw._client = MagicMock()
    gw._client.get = AsyncMock(return_value=fake_resp)
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/task/abc")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body == {
        "task_id": "abc",
        "status": "SUCCESS",
        "doc_id": 42,
        "result": "Success. New document id 42 created",
    }


async def test_task_status_falls_back_to_parsing_result_string(client_factory):
    """When `related_document` is missing (older Paperless / FAILURE rows)
    the doc id should still be extracted from the result string.
    """
    app, _settings, transport = await _logged_in(client_factory)
    gw = _make_gateway()

    fake_resp = MagicMock()
    fake_resp.status_code = 200
    fake_resp.json = MagicMock(return_value=[
        {
            "task_id": "xyz",
            "status": "SUCCESS",
            "result": "Success. New document id 19 created",
            # no related_document key
        }
    ])
    fake_resp.raise_for_status = MagicMock()
    gw._client = MagicMock()
    gw._client.get = AsyncMock(return_value=fake_resp)
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/task/xyz")

    assert resp.json()["doc_id"] == 19


async def test_task_status_unknown_when_paperless_returns_no_rows(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gw = _make_gateway()

    fake_resp = MagicMock()
    fake_resp.status_code = 200
    fake_resp.json = MagicMock(return_value=[])
    fake_resp.raise_for_status = MagicMock()
    gw._client = MagicMock()
    gw._client.get = AsyncMock(return_value=fake_resp)
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/task/old-uuid")

    body = resp.json()
    assert body == {"task_id": "old-uuid", "status": "UNKNOWN", "doc_id": None, "result": None}


async def test_task_status_requires_auth(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/documents/task/any")
    assert resp.status_code == 401


# ---- /api/documents/{id}/status ----


async def test_doc_status_returns_lifecycle_tags_only(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gw = _make_gateway()
    gw.get_document = AsyncMock(
        return_value={
            "id": 9,
            "tags": [
                TAG_IDS["ai-propagated"],
                TAG_IDS["sonstiges"],  # noise — not a lifecycle tag
            ],
        }
    )
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/9/status")

    assert resp.status_code == 200
    body = resp.json()
    assert body == {"id": 9, "lifecycle_tags": ["ai-propagated"]}


async def test_doc_status_empty_when_no_lifecycle_tag(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gw = _make_gateway()
    gw.get_document = AsyncMock(return_value={"id": 9, "tags": []})
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/9/status")

    assert resp.json() == {"id": 9, "lifecycle_tags": []}


async def test_doc_status_404_when_doc_missing(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gw = _make_gateway()
    gw.get_document = AsyncMock(side_effect=PaperlessNotFoundError(1234))
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/1234/status")

    assert resp.status_code == 404


async def test_doc_status_502_on_paperless_auth_error(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gw = _make_gateway()
    gw.get_document = AsyncMock(side_effect=PaperlessAuthError(401))
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/9/status")

    assert resp.status_code == 502


async def test_doc_status_requires_auth(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/documents/9/status")
    assert resp.status_code == 401
