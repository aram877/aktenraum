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


# ---- dismiss-duplicate ----


async def test_dismiss_duplicate_removes_tag(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gateway = AsyncMock()
    gateway.swap_lifecycle_tag = AsyncMock(return_value=[])
    gateway.ensure_tag = AsyncMock(return_value=42)
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/documents/7/dismiss-duplicate")

    assert resp.status_code == 200, resp.text
    assert resp.json()["doc_id"] == 7
    # The endpoint now also stamps a sticky `ai-duplicate-dismissed` tag
    # so future propagations skip re-flagging this doc.
    gateway.ensure_tag.assert_awaited_once_with("ai-duplicate-dismissed")
    gateway.swap_lifecycle_tag.assert_awaited_once()
    kwargs = gateway.swap_lifecycle_tag.await_args.kwargs
    assert kwargs["remove"] == ["ai-duplicate"]
    assert kwargs["add"] == ["ai-duplicate-dismissed"]


async def test_star_document_adds_wichtig_tag(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gateway = AsyncMock()
    gateway.ensure_tag = AsyncMock(return_value=99)
    gateway.swap_lifecycle_tag = AsyncMock(return_value=[])
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/documents/12/star")

    assert resp.status_code == 200, resp.text
    assert resp.json()["doc_id"] == 12
    gateway.ensure_tag.assert_awaited_once_with("wichtig")
    kwargs = gateway.swap_lifecycle_tag.await_args.kwargs
    assert kwargs["remove"] == []
    assert kwargs["add"] == ["wichtig"]


async def test_unstar_document_removes_wichtig_tag(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gateway = AsyncMock()
    gateway.swap_lifecycle_tag = AsyncMock(return_value=[])
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.delete("/api/documents/12/star")

    assert resp.status_code == 200, resp.text
    assert resp.json()["doc_id"] == 12
    kwargs = gateway.swap_lifecycle_tag.await_args.kwargs
    assert kwargs["remove"] == ["wichtig"]
    assert kwargs["add"] == []


async def test_star_document_requires_auth(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post("/api/documents/12/star")
    assert resp.status_code == 401


async def test_dismiss_duplicate_requires_auth(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post("/api/documents/7/dismiss-duplicate")
    assert resp.status_code == 401


async def test_dismiss_duplicate_404_for_missing_doc(client_factory):
    from aktenraum_api.paperless_gw import PaperlessNotFoundError

    app, _settings, transport = await _logged_in(client_factory)
    gateway = AsyncMock()
    gateway.swap_lifecycle_tag = AsyncMock(side_effect=PaperlessNotFoundError(9999))
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/documents/9999/dismiss-duplicate")

    assert resp.status_code == 404


# ---- duplicate-candidates ----


def _ai_fields_doc(
    *,
    doc_id: int,
    correspondent_id: int,
    tag_ids: list[int],
    fields_by_id: dict[int, str | None],
) -> dict:
    """Build a Paperless-shaped doc dict the dedup detector reads."""
    cf = [
        {"field": fid, "value": val}
        for fid, val in fields_by_id.items()
        if val is not None
    ]
    return {
        "id": doc_id,
        "title": f"Doc {doc_id}",
        "correspondent": correspondent_id,
        "document_type": None,
        "created": "2024-03-15",
        "tags": tag_ids,
        "custom_fields": cf,
        "original_file_name": None,
    }


def _candidates_gateway(
    *,
    target: dict,
    candidates: list[dict],
    custom_field_ids: dict[str, int],
    tags: dict[str, int],
    correspondents: dict[str, int] | None = None,
    document_types: dict[str, int] | None = None,
):
    gw = AsyncMock()
    gw.get_document = AsyncMock(return_value=target)
    gw.list_tags = AsyncMock(return_value=dict(tags))
    gw.list_correspondents = AsyncMock(
        return_value=correspondents if correspondents is not None else {}
    )
    gw.list_document_types = AsyncMock(
        return_value=document_types if document_types is not None else {}
    )
    gw._get_custom_field_ids = AsyncMock(return_value=dict(custom_field_ids))
    gw.search_documents = AsyncMock(
        return_value={"results": candidates, "count": len(candidates)}
    )
    return gw


async def test_duplicate_candidates_returns_matched_docs(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    field_ids = {
        "ai_correspondent": 1,
        "ai_issue_date": 2,
        "ai_monetary_amount": 3,
        "ai_reference_numbers": 4,
    }
    tags = {
        "ai-propagated": 10,
        "ai-duplicate": 11,
        "ai-duplicate-dismissed": 12,
    }
    target = _ai_fields_doc(
        doc_id=99,
        correspondent_id=500,
        tag_ids=[10, 11],  # propagated + duplicate
        fields_by_id={
            1: "Telekom",
            2: "2024-03-15",
            3: "EUR42.99",
            4: None,
        },
    )
    cand_match = _ai_fields_doc(
        doc_id=7,
        correspondent_id=500,
        tag_ids=[10, 11],
        fields_by_id={
            1: "Telekom",
            2: "2024-03-15",
            3: "EUR42.99",
            4: None,
        },
    )
    cand_no_match = _ai_fields_doc(
        doc_id=8,
        correspondent_id=500,
        tag_ids=[10],
        fields_by_id={
            1: "Telekom",
            2: "2024-04-01",  # different date
            3: "EUR42.99",
            4: None,
        },
    )
    gw = _candidates_gateway(
        target=target,
        candidates=[cand_match, cand_no_match],
        custom_field_ids=field_ids,
        tags=tags,
    )
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/99/duplicate-candidates")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["doc_id"] == 99
    ids = [c["id"] for c in body["candidates"]]
    assert ids == [7]  # only the match, no false positives


async def test_duplicate_candidates_filters_dismissed_candidates(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    field_ids = {
        "ai_correspondent": 1,
        "ai_issue_date": 2,
        "ai_monetary_amount": 3,
        "ai_reference_numbers": 4,
    }
    tags = {
        "ai-propagated": 10,
        "ai-duplicate": 11,
        "ai-duplicate-dismissed": 12,
    }
    target = _ai_fields_doc(
        doc_id=99,
        correspondent_id=500,
        tag_ids=[10, 11],
        fields_by_id={1: "Telekom", 2: "2024-03-15", 3: "EUR42.99", 4: None},
    )
    cand_dismissed = _ai_fields_doc(
        doc_id=7,
        correspondent_id=500,
        # candidate carries the dismissed tag → filtered out
        tag_ids=[10, 12],
        fields_by_id={1: "Telekom", 2: "2024-03-15", 3: "EUR42.99", 4: None},
    )
    gw = _candidates_gateway(
        target=target,
        candidates=[cand_dismissed],
        custom_field_ids=field_ids,
        tags=tags,
    )
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/99/duplicate-candidates")

    assert resp.status_code == 200
    assert resp.json()["candidates"] == []


async def test_duplicate_candidates_target_dismissed_returns_empty(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    field_ids = {
        "ai_correspondent": 1,
        "ai_issue_date": 2,
        "ai_monetary_amount": 3,
        "ai_reference_numbers": 4,
    }
    tags = {
        "ai-propagated": 10,
        "ai-duplicate": 11,
        "ai-duplicate-dismissed": 12,
    }
    # Target itself carries the dismissed tag → don't even look for matches.
    target = _ai_fields_doc(
        doc_id=99,
        correspondent_id=500,
        tag_ids=[10, 12],
        fields_by_id={1: "Telekom", 2: "2024-03-15", 3: "EUR42.99", 4: None},
    )
    gw = _candidates_gateway(
        target=target,
        candidates=[],
        custom_field_ids=field_ids,
        tags=tags,
    )
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/99/duplicate-candidates")

    assert resp.status_code == 200
    assert resp.json()["candidates"] == []
    # No need to even hit search_documents.
    gw.search_documents.assert_not_awaited()


async def test_duplicate_candidates_404_for_missing_doc(client_factory):
    from aktenraum_api.paperless_gw import PaperlessNotFoundError

    app, _settings, transport = await _logged_in(client_factory)
    gw = AsyncMock()
    gw.get_document = AsyncMock(side_effect=PaperlessNotFoundError(9999))
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/documents/9999/duplicate-candidates")

    assert resp.status_code == 404


async def test_duplicate_candidates_requires_auth(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/documents/99/duplicate-candidates")
    assert resp.status_code == 401
