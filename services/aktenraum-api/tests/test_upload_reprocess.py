from __future__ import annotations

from unittest.mock import AsyncMock

import respx
from aktenraum_core.paperless import LIFECYCLE_TAGS
from httpx import AsyncClient, Response

from aktenraum_api.ai.deps import get_paperless_gateway


async def _logged_in(client_factory, **overrides):
    return await client_factory(
        BOOTSTRAP_USERNAME="admin",
        BOOTSTRAP_PASSWORD="topsecret",
        PAPERLESS_API_TOKEN="dummy",
        AUTO_TAGGER_URL="http://auto-tagger.test:8001",
        **overrides,
    )


async def _login(c: AsyncClient) -> None:
    resp = await c.post(
        "/api/auth/login", json={"username": "admin", "password": "topsecret"}
    )
    assert resp.status_code == 200


# ---- upload ----


async def test_upload_requires_auth(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post(
                "/api/documents/upload",
                files={"files": ("a.pdf", b"%PDF-1.7", "application/pdf")},
            )
    assert resp.status_code == 401


async def test_upload_single_file_accepted(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gateway = AsyncMock()
    gateway.upload_document = AsyncMock(return_value="task-uuid-123")
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/documents/upload",
                files={"files": ("rechnung.pdf", b"%PDF-1.7\nbody", "application/pdf")},
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["results"] == [
        {
            "filename": "rechnung.pdf",
            "status": "accepted",
            "task_id": "task-uuid-123",
            "detail": None,
        }
    ]
    gateway.upload_document.assert_awaited_once()
    kwargs = gateway.upload_document.await_args.kwargs
    assert kwargs["filename"] == "rechnung.pdf"
    assert kwargs["content_type"] == "application/pdf"
    assert kwargs["content"] == b"%PDF-1.7\nbody"


async def test_upload_multi_file_per_file_isolation(client_factory):
    """A failure on one file must not abort the batch."""
    app, _settings, transport = await _logged_in(client_factory)

    async def _upload(*, content, filename, content_type=None, title=None):
        if filename == "bad.pdf":
            raise RuntimeError("boom")
        return f"task-for-{filename}"

    gateway = AsyncMock()
    gateway.upload_document = AsyncMock(side_effect=_upload)
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/documents/upload",
                files=[
                    ("files", ("a.pdf", b"good", "application/pdf")),
                    ("files", ("bad.pdf", b"bad", "application/pdf")),
                    ("files", ("c.pdf", b"good", "application/pdf")),
                ],
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    statuses = {r["filename"]: r["status"] for r in body["results"]}
    assert statuses == {"a.pdf": "accepted", "bad.pdf": "error", "c.pdf": "accepted"}
    bad = next(r for r in body["results"] if r["filename"] == "bad.pdf")
    assert "boom" in (bad.get("detail") or "")


async def test_upload_empty_file_marked_error(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gateway = AsyncMock()
    gateway.upload_document = AsyncMock()
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/documents/upload",
                files={"files": ("empty.pdf", b"", "application/pdf")},
            )

    body = resp.json()
    assert body["results"][0]["status"] == "error"
    gateway.upload_document.assert_not_awaited()


# ---- reprocess ----


@respx.mock
async def test_reprocess_clears_lifecycle_tags_and_pings_auto_tagger(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gateway = AsyncMock()
    gateway.swap_lifecycle_tag = AsyncMock(return_value=[])
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    ping = respx.post("http://auto-tagger.test:8001/trigger/extract").mock(
        return_value=Response(202, json={"queued": True})
    )

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/documents/9/reprocess")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["doc_id"] == 9
    assert body["auto_tagger_notified"] is True
    # Cleared tags should be every lifecycle entry plus the auxiliary
    # ai-low-confidence + ai-auto-approved flags.
    expected_cleared = set(LIFECYCLE_TAGS) | {"ai-low-confidence", "ai-auto-approved"}
    assert set(body["cleared_tags"]) == expected_cleared
    gateway.swap_lifecycle_tag.assert_awaited_once()
    kwargs = gateway.swap_lifecycle_tag.await_args.kwargs
    assert kwargs["add"] == []
    assert set(kwargs["remove"]) == expected_cleared
    assert ping.called
    body_sent = ping.calls.last.request.read()
    assert b'"document_id": 9' in body_sent or b'"document_id":9' in body_sent


@respx.mock
async def test_reprocess_includes_secret_header_when_configured(client_factory):
    app, _settings, transport = await _logged_in(
        client_factory, WEBHOOK_SECRET="hunter2"
    )
    gateway = AsyncMock()
    gateway.swap_lifecycle_tag = AsyncMock(return_value=[])
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    ping = respx.post("http://auto-tagger.test:8001/trigger/extract").mock(
        return_value=Response(202)
    )

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            await c.post("/api/documents/9/reprocess")

    assert ping.called
    assert ping.calls.last.request.headers.get("X-Aktenraum-Secret") == "hunter2"


@respx.mock
async def test_reprocess_succeeds_even_if_auto_tagger_unreachable(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gateway = AsyncMock()
    gateway.swap_lifecycle_tag = AsyncMock(return_value=[])
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    respx.post("http://auto-tagger.test:8001/trigger/extract").mock(
        return_value=Response(503)
    )

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/documents/9/reprocess")

    assert resp.status_code == 200
    body = resp.json()
    assert body["auto_tagger_notified"] is False
    # Tags were still cleared — the poller will pick the doc up regardless.
    gateway.swap_lifecycle_tag.assert_awaited_once()


async def test_reprocess_404_for_missing_doc(client_factory):
    from aktenraum_api.paperless_gw import PaperlessNotFoundError

    app, _settings, transport = await _logged_in(client_factory)
    gateway = AsyncMock()
    gateway.swap_lifecycle_tag = AsyncMock(side_effect=PaperlessNotFoundError(9999))
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/documents/9999/reprocess")

    assert resp.status_code == 404


async def test_reprocess_requires_auth(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post("/api/documents/9/reprocess")
    assert resp.status_code == 401
