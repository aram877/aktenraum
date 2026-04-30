from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

from httpx import AsyncClient

from aktenraum_api.ai.deps import get_paperless_gateway


def _fake_upstream_response(
    *, status_code: int = 200, headers: dict | None = None, body: bytes = b""
):
    """Build a minimal stand-in for httpx.Response that the router can stream
    over without actually opening a network connection.
    """
    resp = MagicMock()
    resp.status_code = status_code
    resp.headers = headers or {}

    async def _aiter():
        yield body

    resp.aiter_bytes = _aiter
    resp.aclose = AsyncMock()
    return resp


def _gateway_with_open(open_side_effect):
    gw = AsyncMock()
    gw.open_document_stream = AsyncMock(side_effect=open_side_effect)
    return gw


async def _logged_in(client_factory):
    app, settings, transport = await client_factory(
        BOOTSTRAP_USERNAME="admin",
        BOOTSTRAP_PASSWORD="topsecret",
        PAPERLESS_API_TOKEN="dummy",
    )
    return app, settings, transport


async def _login(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "topsecret"},
    )
    assert resp.status_code == 200


async def test_preview_returns_pdf_stream(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    upstream = _fake_upstream_response(
        headers={"content-type": "application/pdf"},
        body=b"%PDF-1.7\nbody",
    )
    app.dependency_overrides[get_paperless_gateway] = lambda: _gateway_with_open(
        lambda doc_id, kind: upstream if kind == "preview" else None
    )

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/9/preview")

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/pdf"
    assert resp.headers["cache-control"] == "private, max-age=300"
    assert resp.content == b"%PDF-1.7\nbody"


async def test_download_forwards_content_disposition(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    upstream = _fake_upstream_response(
        headers={
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="rechnung.pdf"',
        },
        body=b"%PDF-1.7\nbody",
    )
    app.dependency_overrides[get_paperless_gateway] = lambda: _gateway_with_open(
        lambda doc_id, kind: upstream
    )

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/9/download")

    assert resp.status_code == 200
    assert resp.headers["content-disposition"] == 'attachment; filename="rechnung.pdf"'
    assert resp.headers["cache-control"] == "private, no-store"


async def test_download_uses_default_media_type_when_upstream_omits_it(
    client_factory,
):
    app, _settings, transport = await _logged_in(client_factory)
    upstream = _fake_upstream_response(headers={}, body=b"raw")
    app.dependency_overrides[get_paperless_gateway] = lambda: _gateway_with_open(
        lambda doc_id, kind: upstream
    )

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/9/download")

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/octet-stream"


async def test_preview_404_when_document_missing(client_factory):
    from aktenraum_api.paperless_gw import PaperlessNotFoundError

    app, _settings, transport = await _logged_in(client_factory)

    def _raise(doc_id, kind):
        raise PaperlessNotFoundError(doc_id)

    app.dependency_overrides[get_paperless_gateway] = lambda: _gateway_with_open(_raise)

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/9999/preview")

    assert resp.status_code == 404


async def test_preview_502_when_paperless_rejects_token(client_factory):
    from aktenraum_api.paperless_gw import PaperlessAuthError

    app, _settings, transport = await _logged_in(client_factory)

    def _raise(doc_id, kind):
        raise PaperlessAuthError(401)

    app.dependency_overrides[get_paperless_gateway] = lambda: _gateway_with_open(_raise)

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/1/preview")

    assert resp.status_code == 502


async def test_endpoints_require_auth(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            assert (await c.get("/api/documents/1/preview")).status_code == 401
            assert (await c.get("/api/documents/1/download")).status_code == 401
