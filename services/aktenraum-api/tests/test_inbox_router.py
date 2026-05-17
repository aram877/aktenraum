from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest
import respx
from httpx import AsyncClient, Response

from aktenraum_api.ai.deps import get_paperless_gateway

# Custom-field id <-> name fixtures matching the live Paperless schema.
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
    "ai-propagation-error": 5,
    "ai-error": 6,
    "ai-low-confidence": 7,
    "ai-auto-approved": 8,
    "sonstiges": 99,
}


def _doc(
    doc_id: int,
    *,
    title: str = "Test Doc",
    tags: list[int] | None = None,
    custom_fields: list[dict] | None = None,
    content: str = "",
    created_date: str = "2024-01-15",
) -> dict:
    return {
        "id": doc_id,
        "title": title,
        "created_date": created_date,
        "tags": tags if tags is not None else [TAG_IDS["ai-pending"]],
        "custom_fields": custom_fields or [],
        "content": content,
    }


def _make_fake_gateway(
    *,
    documents: dict[int, dict] | None = None,
    list_payload: dict | None = None,
):
    gateway = AsyncMock()
    docs = documents or {}
    gateway.list_tags = AsyncMock(return_value=dict(TAG_IDS))
    gateway._get_custom_field_ids = AsyncMock(return_value=dict(FIELD_IDS))
    gateway.search_documents = AsyncMock(
        return_value=list_payload
        or {"results": list(docs.values()), "count": len(docs)}
    )

    async def _get_doc(doc_id):
        from aktenraum_api.paperless_gw import PaperlessNotFoundError

        if doc_id not in docs:
            raise PaperlessNotFoundError(doc_id)
        return docs[doc_id]

    gateway.get_document = AsyncMock(side_effect=_get_doc)
    gateway.patch_document_custom_fields = AsyncMock(
        side_effect=lambda doc_id, kv, **_kw: kv
    )
    gateway.swap_lifecycle_tag = AsyncMock(return_value=[])

    async def _stream(doc_id):
        from aktenraum_api.paperless_gw import PaperlessNotFoundError

        if doc_id not in docs:
            raise PaperlessNotFoundError(doc_id)
        for chunk in (b"%PDF-1.7", b"\nfake-bytes"):
            yield chunk

    # stream_preview is not async — it's a generator function; avoid AsyncMock here.
    gateway.stream_preview = _stream
    return gateway


async def _logged_in(client_factory, **overrides):
    # Default AUTO_TAGGER_URL="" so legacy tests don't make a (slow,
    # timing-out) HTTP call to the propagate trigger; tests that
    # specifically exercise the trigger pass AUTO_TAGGER_URL explicitly.
    base = {
        "BOOTSTRAP_USERNAME": "admin",
        "BOOTSTRAP_PASSWORD": "topsecret",
        "PAPERLESS_API_TOKEN": "dummy",
        "AUTO_TAGGER_URL": "",
    }
    base.update(overrides)
    app, settings, transport = await client_factory(**base)
    return app, settings, transport


async def _login(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "topsecret"},
    )
    assert resp.status_code == 200


async def test_list_requires_auth(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/inbox/")
    assert resp.status_code == 401


async def test_list_returns_pending_with_low_confidence_flag(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    docs = {
        1: _doc(
            1,
            title="Plain Doc",
            tags=[TAG_IDS["ai-pending"]],
            custom_fields=[
                {"field": FIELD_IDS["ai_correspondent"], "value": "Telekom"},
                {"field": FIELD_IDS["ai_document_type"], "value": "Rechnung"},
                {"field": FIELD_IDS["ai_confidence"], "value": 0.9},
            ],
        ),
        2: _doc(
            2,
            title="Shaky Doc",
            tags=[TAG_IDS["ai-pending"], TAG_IDS["ai-low-confidence"]],
            custom_fields=[
                {"field": FIELD_IDS["ai_correspondent"], "value": "Unbekannt"},
                {"field": FIELD_IDS["ai_confidence"], "value": 0.4},
            ],
        ),
    }
    fake_gateway = _make_fake_gateway(documents=docs)
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/inbox/")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 2
    by_id = {r["id"]: r for r in body["results"]}
    assert by_id[1]["low_confidence"] is False
    assert by_id[1]["ai_correspondent"] == "Telekom"
    assert by_id[2]["low_confidence"] is True


async def test_list_passes_pagination_params(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    fake_gateway = _make_fake_gateway(documents={})
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/inbox/?page=3&page_size=5")

    assert resp.status_code == 200
    fake_gateway.search_documents.assert_awaited()
    call_args = fake_gateway.search_documents.await_args
    params = call_args.args[0]
    assert params["tags__id"] == TAG_IDS["ai-pending"]
    assert params["page"] == 3
    assert params["ordering"] == "-modified"
    assert call_args.kwargs["page_size"] == 5


async def test_detail_returns_full_payload(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    docs = {
        9: _doc(
            9,
            title="NOV-2025-ARAM",
            tags=[TAG_IDS["ai-pending"]],
            custom_fields=[
                {"field": FIELD_IDS["ai_document_type"], "value": "Gehaltsabrechnung"},
                {"field": FIELD_IDS["ai_correspondent"], "value": "interact GmbH"},
                {"field": FIELD_IDS["ai_issue_date"], "value": "2025-11-24"},
                {"field": FIELD_IDS["ai_summary_de"], "value": "Lange Zusammenfassung."},
                {"field": FIELD_IDS["ai_confidence"], "value": 0.99},
            ],
            content="Gehaltsabrechnung November 2025 für Aram " * 100,
        )
    }
    fake_gateway = _make_fake_gateway(documents=docs)
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/inbox/9")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["id"] == 9
    assert body["ai_document_type"] == "Gehaltsabrechnung"
    assert body["ai_correspondent"] == "interact GmbH"
    assert body["ai_summary_de"] == "Lange Zusammenfassung."
    assert body["ai_confidence"] == 0.99
    assert "Gehaltsabrechnung" in body["content_excerpt"]
    assert len(body["content_excerpt"]) <= 2000
    assert "ai-pending" in body["tags"]


async def test_detail_404_for_missing_doc(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    fake_gateway = _make_fake_gateway(documents={})
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/inbox/9999")

    assert resp.status_code == 404


async def test_patch_calls_gateway_with_supplied_fields(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    docs = {1: _doc(1)}
    fake_gateway = _make_fake_gateway(documents=docs)
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.patch(
                "/api/inbox/1",
                json={"ai_correspondent": "Telekom", "ai_issue_date": "2024-05-01"},
            )

    assert resp.status_code == 200
    fake_gateway.patch_document_custom_fields.assert_awaited_once()
    args = fake_gateway.patch_document_custom_fields.await_args.args
    assert args[0] == 1
    assert args[1] == {
        "ai_correspondent": "Telekom",
        "ai_issue_date": "2024-05-01",
    }


async def test_patch_empty_body_is_noop(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    docs = {1: _doc(1)}
    fake_gateway = _make_fake_gateway(documents=docs)
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.patch("/api/inbox/1", json={})

    assert resp.status_code == 200
    fake_gateway.patch_document_custom_fields.assert_not_awaited()


async def test_approve_swaps_tags_and_optionally_patches(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    docs = {1: _doc(1)}
    fake_gateway = _make_fake_gateway(documents=docs)
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/inbox/1/approve",
                json={"ai_correspondent": "Telekom"},
            )

    assert resp.status_code == 200
    # approve now passes prefetched_doc so the gateway can skip its merge-read.
    fake_gateway.patch_document_custom_fields.assert_awaited_once()
    call = fake_gateway.patch_document_custom_fields.await_args
    assert call.args[0] == 1
    assert call.args[1] == {"ai_correspondent": "Telekom"}
    assert "prefetched_doc" in call.kwargs
    fake_gateway.swap_lifecycle_tag.assert_awaited_once_with(
        1,
        remove=["ai-pending", "ai-low-confidence"],
        add=["ai-approved"],
    )


async def test_approve_with_no_body_skips_patch(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    docs = {1: _doc(1)}
    fake_gateway = _make_fake_gateway(documents=docs)
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/inbox/1/approve")

    assert resp.status_code == 200
    fake_gateway.patch_document_custom_fields.assert_not_awaited()
    fake_gateway.swap_lifecycle_tag.assert_awaited_once()


@respx.mock
async def test_approve_fires_propagate_trigger(client_factory):
    """Approve POSTs to the auto-tagger's /trigger/propagate webhook so
    propagation runs immediately rather than waiting on the 30s poller."""
    app, _settings, transport = await _logged_in(
        client_factory,
        AUTO_TAGGER_URL="http://auto-tagger.test:8001",
    )
    docs = {1: _doc(1)}
    fake_gateway = _make_fake_gateway(documents=docs)
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gateway

    ping = respx.post("http://auto-tagger.test:8001/trigger/propagate").mock(
        return_value=Response(202, json={"queued": 1})
    )

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/inbox/1/approve")

    assert resp.status_code == 200
    fake_gateway.swap_lifecycle_tag.assert_awaited_once()
    assert ping.called
    body_sent = ping.calls.last.request.read()
    assert b'"document_id": 1' in body_sent or b'"document_id":1' in body_sent


@respx.mock
async def test_approve_trigger_includes_secret_header(client_factory):
    app, _settings, transport = await _logged_in(
        client_factory,
        AUTO_TAGGER_URL="http://auto-tagger.test:8001",
        WEBHOOK_SECRET="hunter2",
    )
    docs = {1: _doc(1)}
    fake_gateway = _make_fake_gateway(documents=docs)
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gateway

    ping = respx.post("http://auto-tagger.test:8001/trigger/propagate").mock(
        return_value=Response(202)
    )

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            await c.post("/api/inbox/1/approve")

    assert ping.called
    assert ping.calls.last.request.headers.get("X-Aktenraum-Secret") == "hunter2"


@respx.mock
async def test_approve_succeeds_when_trigger_returns_5xx(client_factory):
    """If the trigger fails, the tag swap was already applied and the
    safety-net poller will catch the doc. Approve still returns 200."""
    app, _settings, transport = await _logged_in(
        client_factory,
        AUTO_TAGGER_URL="http://auto-tagger.test:8001",
    )
    docs = {1: _doc(1)}
    fake_gateway = _make_fake_gateway(documents=docs)
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gateway

    respx.post("http://auto-tagger.test:8001/trigger/propagate").mock(
        return_value=Response(503)
    )

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/inbox/1/approve")

    assert resp.status_code == 200
    fake_gateway.swap_lifecycle_tag.assert_awaited_once()


@respx.mock
async def test_approve_skips_trigger_when_url_empty(client_factory):
    """AUTO_TAGGER_URL="" → no outbound HTTP, approve still succeeds."""
    app, _settings, transport = await _logged_in(
        client_factory,
        AUTO_TAGGER_URL="",
    )
    docs = {1: _doc(1)}
    fake_gateway = _make_fake_gateway(documents=docs)
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gateway

    # A route that, if hit, would fail loudly — confirms no outbound call.
    sentinel = respx.post("http://auto-tagger.test:8001/trigger/propagate").mock(
        return_value=Response(500)
    )

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/inbox/1/approve")

    assert resp.status_code == 200
    fake_gateway.swap_lifecycle_tag.assert_awaited_once()
    assert not sentinel.called


async def test_reject_swaps_tags_without_patch(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    docs = {1: _doc(1)}
    fake_gateway = _make_fake_gateway(documents=docs)
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/inbox/1/reject")

    assert resp.status_code == 200
    fake_gateway.patch_document_custom_fields.assert_not_awaited()
    fake_gateway.swap_lifecycle_tag.assert_awaited_once_with(
        1,
        remove=["ai-pending", "ai-low-confidence"],
        add=["ai-rejected"],
    )


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("get", "/api/inbox/1", None),
        ("patch", "/api/inbox/1", {}),
        ("post", "/api/inbox/1/approve", None),
        ("post", "/api/inbox/1/reject", None),
        ("get", "/api/inbox/1/preview", None),
    ],
)
async def test_endpoints_require_auth(
    client_factory, method: str, path: str, body: Any
):
    app, _settings, transport = await _logged_in(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            handler = getattr(c, method)
            resp = await (
                handler(path, json=body) if body is not None else handler(path)
            )
    assert resp.status_code == 401


async def test_preview_streams_pdf_bytes(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    docs = {1: _doc(1)}
    fake_gateway = _make_fake_gateway(documents=docs)
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/inbox/1/preview")

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/pdf"
    assert resp.headers["cache-control"] == "private, max-age=300"
    assert resp.content == b"%PDF-1.7\nfake-bytes"


async def test_preview_404_for_missing_doc(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    fake_gateway = _make_fake_gateway(documents={})
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/inbox/123/preview")

    assert resp.status_code == 404
