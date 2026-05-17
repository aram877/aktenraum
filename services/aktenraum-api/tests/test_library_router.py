from __future__ import annotations

from unittest.mock import AsyncMock

import respx
from httpx import AsyncClient, Response

from aktenraum_api.ai.deps import get_paperless_gateway

# Same fixture shape as test_inbox_router so the projection plumbing is exercised.
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
    title: str = "Doc",
    tags: list[int] | None = None,
    custom_fields: list[dict] | None = None,
    correspondent: int | None = None,
    document_type: int | None = None,
    created_date: str = "2024-01-15",
):
    return {
        "id": doc_id,
        "title": title,
        "correspondent": correspondent,
        "document_type": document_type,
        "created_date": created_date,
        "tags": tags or [],
        "custom_fields": custom_fields or [],
    }


def _make_gateway(*, documents: list[dict], correspondents=None, document_types=None):
    gw = AsyncMock()
    gw.list_correspondents = AsyncMock(return_value=correspondents or {})
    gw.list_document_types = AsyncMock(return_value=document_types or {})
    gw.list_tags = AsyncMock(return_value=dict(TAG_IDS))
    gw._get_custom_field_ids = AsyncMock(return_value=dict(FIELD_IDS))
    gw.search_documents = AsyncMock(
        return_value={"results": documents, "count": len(documents)}
    )
    return gw


async def _logged_in(client_factory, **overrides):
    # Default AUTO_TAGGER_URL="" so legacy library tests don't burn 2s
    # on each request waiting for the now-baked-in /processing fetch to
    # time out. Pin-specific tests pass AUTO_TAGGER_URL explicitly.
    base = {
        "BOOTSTRAP_USERNAME": "admin",
        "BOOTSTRAP_PASSWORD": "topsecret",
        "PAPERLESS_API_TOKEN": "dummy",
        "AUTO_TAGGER_URL": "",
    }
    base.update(overrides)
    return await client_factory(**base)


async def _login(c: AsyncClient) -> None:
    resp = await c.post(
        "/api/auth/login",
        json={"username": "admin", "password": "topsecret"},
    )
    assert resp.status_code == 200


async def test_library_requires_auth(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/library/")
    assert resp.status_code == 401


async def test_library_excludes_pending_via_tags_id_none(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gateway = _make_gateway(documents=[])
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/library/")

    assert resp.status_code == 200
    sent = gateway.search_documents.await_args.args[0]
    assert sent.get("tags__id__none") == TAG_IDS["ai-pending"]
    assert sent.get("ordering") == "-created"
    assert sent.get("page") == 1


async def test_library_passes_filter_params_through(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gateway = _make_gateway(
        documents=[],
        correspondents={"Telekom": 12},
        document_types={"Rechnung": 5},
    )
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get(
                "/api/library/?document_type=Rechnung&correspondent=Telekom"
                "&date_from=2024-01-01&date_to=2024-12-31&text=zahlung"
            )

    assert resp.status_code == 200
    sent = gateway.search_documents.await_args.args[0]
    assert sent["document_type__id"] == 5
    assert sent["correspondent__id"] == 12
    assert sent["created__date__gte"] == "2024-01-01"
    assert sent["created__date__lte"] == "2024-12-31"
    assert sent["query"] == "zahlung"


async def test_library_unknown_correspondent_falls_through_to_text(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gateway = _make_gateway(
        documents=[],
        correspondents={"Telekom": 12},
    )
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            await c.get("/api/library/?correspondent=Vodafone")

    sent = gateway.search_documents.await_args.args[0]
    assert "correspondent__id" not in sent
    assert sent.get("query") == "Vodafone"


async def test_library_projects_lifecycle_badges(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    docs = [
        _doc(
            1,
            title="Approved Rechnung",
            tags=[TAG_IDS["ai-propagated"], TAG_IDS["sonstiges"]],
            correspondent=12,
            document_type=5,
            custom_fields=[],
        ),
        _doc(
            2,
            title="Rejected Doc",
            tags=[TAG_IDS["ai-rejected"]],
            custom_fields=[
                {"field": FIELD_IDS["ai_correspondent"], "value": "Acme"},
                {"field": FIELD_IDS["ai_document_type"], "value": "Sonstiges"},
            ],
        ),
    ]
    gateway = _make_gateway(
        documents=docs,
        correspondents={"Telekom": 12},
        document_types={"Rechnung": 5},
    )
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/library/")

    assert resp.status_code == 200
    body = resp.json()
    by_id = {r["id"]: r for r in body["results"]}
    assert by_id[1]["lifecycle_tags"] == ["ai-propagated"]
    assert by_id[1]["correspondent"] == "Telekom"
    assert by_id[1]["document_type"] == "Rechnung"
    assert by_id[2]["lifecycle_tags"] == ["ai-rejected"]
    # When the native FK is unset, fall back to the AI custom field.
    assert by_id[2]["correspondent"] == "Acme"
    assert by_id[2]["document_type"] == "Sonstiges"


async def test_library_rejects_unsafe_ordering(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gateway = _make_gateway(documents=[])
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/library/?ordering=evil")

    assert resp.status_code == 422


async def test_library_tags_filter_emits_tags_id_all_csv(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gateway = _make_gateway(documents=[])
    # Replace the tag map so the test can assert the resolved id list.
    gateway.list_tags = AsyncMock(
        return_value={
            "ai-pending": TAG_IDS["ai-pending"],
            "Lebenslauf": 50,
            "Versicherung": 51,
        }
    )
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get(
                "/api/library/?tags=Lebenslauf&tags=Versicherung"
            )

    assert resp.status_code == 200
    sent = gateway.search_documents.await_args.args[0]
    assert sent.get("tags__id__all") == "50,51"


async def test_library_unknown_tag_short_circuits_without_calling_paperless(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gateway = _make_gateway(documents=[])
    gateway.list_tags = AsyncMock(
        return_value={"ai-pending": TAG_IDS["ai-pending"], "Lebenslauf": 50}
    )
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/library/?tags=DoesNotExist")

    assert resp.status_code == 200
    body = resp.json()
    assert body["results"] == []
    assert body["total"] == 0
    gateway.search_documents.assert_not_awaited()


async def test_library_projects_user_tags_excluding_lifecycle(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    docs = [
        _doc(
            1,
            tags=[
                TAG_IDS["ai-propagated"],
                TAG_IDS["ai-low-confidence"],
                TAG_IDS["sonstiges"],
            ],
        )
    ]
    gateway = _make_gateway(documents=docs)
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/library/")

    body = resp.json()
    row = body["results"][0]
    assert row["lifecycle_tags"] == ["ai-propagated"]
    # User-facing tag list excludes the lifecycle vocabulary AND the
    # ai-low-confidence auxiliary so the chip cloud stays clean.
    assert row["tags"] == ["sonstiges"]


async def test_tag_facet_counts_only_non_pending_user_tags(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    # Three docs: two carry "Lebenslauf", one has only the lifecycle tag.
    # The facet should ignore lifecycle/auxiliary names and apply the
    # min-count threshold (≥2) so thin tags drop out.
    docs = [
        _doc(1, tags=[TAG_IDS["ai-propagated"], 50]),
        _doc(2, tags=[TAG_IDS["ai-approved"], 50]),
        _doc(3, tags=[TAG_IDS["ai-propagated"], 51]),  # "Versicherung" appears once
    ]
    gateway = _make_gateway(documents=docs)
    gateway.list_tags = AsyncMock(
        return_value={
            **TAG_IDS,
            "Lebenslauf": 50,
            "Versicherung": 51,
        }
    )
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/library/tags")

    assert resp.status_code == 200
    body = resp.json()
    # Only "Lebenslauf" (count 2) clears the threshold; lifecycle/auxiliary
    # names never appear regardless of count.
    assert body["results"] == [{"name": "Lebenslauf", "count": 2}]
    sent = gateway.search_documents.await_args.args[0]
    assert sent.get("tags__id__none") == TAG_IDS["ai-pending"]


async def test_library_pagination_defaults(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    gateway = _make_gateway(documents=[])
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/library/?page=3&page_size=10")

    assert resp.status_code == 200
    sent = gateway.search_documents.await_args
    assert sent.args[0]["page"] == 3
    assert sent.kwargs["page_size"] == 10


# ---- in-flight pin (library-ux-improvements) ----


def _gateway_with_pinnable_doc(pinned_id: int, *, pinned_title: str = "Wird verarbeitet"):
    """Library natural-sort returns doc 10 + 11; gateway.get_document(pinned_id)
    is wired to return a synthetic doc carrying ai-pending or ai-approved tags."""
    natural = [
        _doc(10, title="Older A", correspondent=12, document_type=5),
        _doc(11, title="Older B", correspondent=12, document_type=5),
    ]
    gw = _make_gateway(
        documents=natural,
        correspondents={"Telekom": 12},
        document_types={"Rechnung": 5},
    )

    pinned_doc = _doc(
        pinned_id,
        title=pinned_title,
        correspondent=12,
        document_type=5,
    )
    gw.get_document = AsyncMock(return_value=pinned_doc)
    return gw


@respx.mock
async def test_library_page1_pins_in_flight_doc(client_factory):
    """Doc id 42 is in the extraction slot. It should appear as row 1 of
    page 1 with is_processing=True, ahead of the natural-sort rows."""
    app, _settings, transport = await _logged_in(
        client_factory, AUTO_TAGGER_URL="http://auto-tagger.test:8001"
    )
    gw = _gateway_with_pinnable_doc(42)
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    respx.get("http://auto-tagger.test:8001/processing").mock(
        return_value=Response(
            200,
            json={
                "processing": [42],
                "slots": {"extraction": 42, "propagation": None, "indexer": None},
            },
        )
    )

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/library/")

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2  # Paperless natural count, NOT inflated by the pin
    ids = [r["id"] for r in body["results"]]
    assert ids == [42, 10, 11]
    assert body["results"][0]["is_processing"] is True
    assert body["results"][1]["is_processing"] is False
    assert body["results"][2]["is_processing"] is False


@respx.mock
async def test_library_page1_dedupes_pinned_doc_against_natural_sort(client_factory):
    """If the in-flight doc id is ALSO in the natural-sort page, it must
    appear exactly once — as the pinned row, not duplicated below."""
    app, _settings, transport = await _logged_in(
        client_factory, AUTO_TAGGER_URL="http://auto-tagger.test:8001"
    )
    # Natural-sort returns the same id 11 the auto-tagger is processing.
    gw = _gateway_with_pinnable_doc(11)
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    respx.get("http://auto-tagger.test:8001/processing").mock(
        return_value=Response(
            200,
            json={
                "processing": [11],
                "slots": {"extraction": None, "propagation": 11, "indexer": None},
            },
        )
    )

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/library/")

    assert resp.status_code == 200
    ids = [r["id"] for r in resp.json()["results"]]
    # 11 is pinned to the top; the natural-sort row for 11 is removed
    # so it doesn't appear twice. 10 follows.
    assert ids == [11, 10]


@respx.mock
async def test_library_page2_no_pin_no_processing_call(client_factory):
    """Page 2+ behaviour is unchanged — no /processing fetch, no pinned
    rows. Verifies via respx that the GET was never made."""
    app, _settings, transport = await _logged_in(
        client_factory, AUTO_TAGGER_URL="http://auto-tagger.test:8001"
    )
    gw = _make_gateway(
        documents=[_doc(20, title="Page 2 row")],
        correspondents={"Telekom": 12},
        document_types={"Rechnung": 5},
    )
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    processing = respx.get("http://auto-tagger.test:8001/processing").mock(
        return_value=Response(
            200,
            json={"processing": [99], "slots": {"extraction": 99}},
        )
    )

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/library/?page=2")

    assert resp.status_code == 200
    ids = [r["id"] for r in resp.json()["results"]]
    assert ids == [20]
    assert not processing.called


@respx.mock
async def test_library_page1_falls_back_when_auto_tagger_unreachable(client_factory):
    """A 5xx from /processing must NOT fail the library request — it
    falls back to plain natural-sort with no pinned rows."""
    app, _settings, transport = await _logged_in(
        client_factory, AUTO_TAGGER_URL="http://auto-tagger.test:8001"
    )
    gw = _make_gateway(
        documents=[
            _doc(10, title="Older A"),
            _doc(11, title="Older B"),
        ],
    )
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    respx.get("http://auto-tagger.test:8001/processing").mock(
        return_value=Response(503)
    )

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/library/")

    assert resp.status_code == 200
    body = resp.json()
    ids = [r["id"] for r in body["results"]]
    assert ids == [10, 11]
    assert all(row["is_processing"] is False for row in body["results"])


async def test_library_page1_with_empty_auto_tagger_url_skips_processing_call(
    client_factory,
):
    """When AUTO_TAGGER_URL is empty (the test default), no /processing
    fetch happens and is_processing stays False on every row. Asserted
    without respx — if the code accidentally tried to make the call,
    it would hit the real network."""
    app, _settings, transport = await _logged_in(client_factory)
    gw = _make_gateway(
        documents=[_doc(10, title="Older A")],
    )
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/library/")

    assert resp.status_code == 200
    body = resp.json()
    assert body["results"][0]["is_processing"] is False
