from __future__ import annotations

from unittest.mock import AsyncMock

from httpx import AsyncClient

from aktenraum_api.ai.deps import get_paperless_gateway, get_vector_store_optional

FIELD_IDS = {
    "ai_document_type": 1,
    "ai_correspondent": 2,
    "ai_summary_de": 9,
}

CORRESPONDENTS = {"Telekom": 10, "AOK": 11}
DOC_TYPES = {"Rechnung": 20, "Versicherung": 21}


def _trash_row(
    doc_id: int,
    *,
    title: str = "Trashed Doc",
    deleted_at: str = "2026-05-10T08:00:00Z",
    correspondent: int | None = None,
    document_type: int | None = None,
    custom_fields: list[dict] | None = None,
):
    return {
        "id": doc_id,
        "title": title,
        "correspondent": correspondent,
        "document_type": document_type,
        "deleted_at": deleted_at,
        "created_date": "2024-01-15",
        "custom_fields": custom_fields or [],
    }


def _make_gateway(
    *,
    trash_rows: list[dict] | None = None,
    list_pages: list[dict] | None = None,
):
    """Build a fake gateway exposing only the methods the trash service
    actually calls. `list_pages` lets a test simulate paginated trash for
    the empty-all flow; default is a single page."""
    gw = AsyncMock()
    gw.list_correspondents = AsyncMock(return_value=dict(CORRESPONDENTS))
    gw.list_document_types = AsyncMock(return_value=dict(DOC_TYPES))
    gw._get_custom_field_ids = AsyncMock(return_value=dict(FIELD_IDS))

    if list_pages is not None:
        gw.list_trashed_documents = AsyncMock(side_effect=list_pages)
    else:
        rows = trash_rows or []
        gw.list_trashed_documents = AsyncMock(
            return_value={
                "results": rows,
                "count": len(rows),
                "next": None,
                "previous": None,
                "all": [r["id"] for r in rows],
            }
        )
    gw.restore_documents = AsyncMock(return_value=None)
    gw.empty_trash = AsyncMock(return_value=None)
    return gw


def _make_vector_store():
    vs = AsyncMock()
    vs.delete_by_doc_id = AsyncMock(return_value=None)
    return vs


async def _logged_in(client_factory, **overrides):
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


# ---- /api/trash/ list ----


async def test_list_requires_auth(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/trash/")
    assert resp.status_code == 401


async def test_list_returns_trashed_docs_with_native_lookups(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    rows = [
        _trash_row(
            1,
            title="Telekom Rechnung",
            correspondent=10,
            document_type=20,
            custom_fields=[{"field": 9, "value": "Vorgang abgeschlossen."}],
        ),
        _trash_row(
            2,
            title="AOK Bestätigung",
            correspondent=11,
            document_type=21,
            custom_fields=[
                {"field": 2, "value": "AOK"},
                {"field": 1, "value": "Versicherung"},
            ],
        ),
    ]
    fake_gw = _make_gateway(trash_rows=rows)
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/trash/")

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["page"] == 1
    assert body["page_size"] == 20
    titles = [r["title"] for r in body["results"]]
    assert titles == ["Telekom Rechnung", "AOK Bestätigung"]
    # Native lookups populated where ids matched.
    assert body["results"][0]["correspondent"] == "Telekom"
    assert body["results"][0]["document_type"] == "Rechnung"
    # AI fallback used for the row whose native fields are unset (-1).
    assert body["results"][1]["ai_correspondent"] == "AOK"
    assert body["results"][1]["ai_document_type"] == "Versicherung"
    # deleted_at survives the round-trip.
    assert body["results"][0]["deleted_at"].startswith("2026-05-10")


async def test_list_pagination_passes_page_params_to_gateway(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    fake_gw = _make_gateway(trash_rows=[])
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/trash/?page=3&page_size=5")

    assert resp.status_code == 200
    fake_gw.list_trashed_documents.assert_awaited_once()
    kwargs = fake_gw.list_trashed_documents.await_args.kwargs
    assert kwargs["page"] == 3
    assert kwargs["page_size"] == 5
    # Default ordering is oldest-deleted-first.
    assert kwargs["ordering"] == "deleted_at"


async def test_list_rejects_unsafe_ordering(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    fake_gw = _make_gateway(trash_rows=[])
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.get("/api/trash/?ordering=__sql_injection__")

    assert resp.status_code == 200
    # Unknown ordering values fall back to the default rather than 4xx.
    kwargs = fake_gw.list_trashed_documents.await_args.kwargs
    assert kwargs["ordering"] == "deleted_at"


# ---- /api/trash/{id}/restore ----


async def test_restore_calls_gateway_and_returns_204(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    fake_gw = _make_gateway()
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/trash/42/restore")

    assert resp.status_code == 204
    fake_gw.restore_documents.assert_awaited_once_with([42])


async def test_restore_404_for_id_not_in_trash(client_factory):
    from aktenraum_api.paperless_gw import PaperlessNotFoundError

    app, _settings, transport = await _logged_in(client_factory)
    fake_gw = _make_gateway()
    fake_gw.restore_documents = AsyncMock(side_effect=PaperlessNotFoundError(9999))
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/trash/9999/restore")

    assert resp.status_code == 404


# ---- /api/trash/{id}/delete (hard-delete with Qdrant cleanup) ----


async def test_delete_forever_calls_paperless_then_qdrant(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    fake_gw = _make_gateway()
    fake_vs = _make_vector_store()
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gw
    app.dependency_overrides[get_vector_store_optional] = lambda: fake_vs

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/trash/42/delete")

    assert resp.status_code == 204
    fake_gw.empty_trash.assert_awaited_once_with(doc_ids=[42])
    fake_vs.delete_by_doc_id.assert_awaited_once_with(42)


async def test_delete_forever_swallows_qdrant_failure(client_factory):
    """Paperless is the source of truth; an unreachable Qdrant must not
    fail the user-visible request — the orphan is recoverable."""
    app, _settings, transport = await _logged_in(client_factory)
    fake_gw = _make_gateway()
    fake_vs = _make_vector_store()
    fake_vs.delete_by_doc_id = AsyncMock(side_effect=RuntimeError("qdrant down"))
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gw
    app.dependency_overrides[get_vector_store_optional] = lambda: fake_vs

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/trash/42/delete")

    assert resp.status_code == 204
    fake_gw.empty_trash.assert_awaited_once()


async def test_delete_forever_works_without_vector_store(client_factory):
    """When QDRANT_URL is empty the dependency returns None; the
    endpoint must still succeed."""
    app, _settings, transport = await _logged_in(client_factory)
    fake_gw = _make_gateway()
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gw
    app.dependency_overrides[get_vector_store_optional] = lambda: None

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/trash/42/delete")

    assert resp.status_code == 204
    fake_gw.empty_trash.assert_awaited_once_with(doc_ids=[42])


async def test_delete_forever_404_for_id_not_in_trash(client_factory):
    from aktenraum_api.paperless_gw import PaperlessNotFoundError

    app, _settings, transport = await _logged_in(client_factory)
    fake_gw = _make_gateway()
    fake_gw.empty_trash = AsyncMock(side_effect=PaperlessNotFoundError(9999))
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gw
    app.dependency_overrides[get_vector_store_optional] = lambda: None

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/trash/9999/delete")

    assert resp.status_code == 404


# ---- /api/trash/empty ----


async def test_empty_hard_deletes_all_and_reports_count(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    rows = [_trash_row(i) for i in (1, 2, 3, 4, 5, 6, 7)]
    fake_gw = _make_gateway(trash_rows=rows)
    fake_vs = _make_vector_store()
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gw
    app.dependency_overrides[get_vector_store_optional] = lambda: fake_vs

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/trash/empty")

    assert resp.status_code == 200
    assert resp.json() == {"emptied": 7}
    fake_gw.empty_trash.assert_awaited_once_with(doc_ids=[1, 2, 3, 4, 5, 6, 7])
    assert fake_vs.delete_by_doc_id.await_count == 7


async def test_empty_on_empty_trash_is_noop(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    fake_gw = _make_gateway(trash_rows=[])
    fake_vs = _make_vector_store()
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gw
    app.dependency_overrides[get_vector_store_optional] = lambda: fake_vs

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/trash/empty")

    assert resp.status_code == 200
    assert resp.json() == {"emptied": 0}
    fake_gw.empty_trash.assert_not_awaited()
    fake_vs.delete_by_doc_id.assert_not_awaited()


async def test_empty_paginates_when_trash_has_more_than_one_page(client_factory):
    """The trash service paginates id-enumeration at 100/page; verify
    we exhaust all pages before issuing the empty call."""
    app, _settings, transport = await _logged_in(client_factory)
    page1_rows = [_trash_row(i) for i in range(1, 101)]
    page2_rows = [_trash_row(i) for i in range(101, 121)]
    fake_gw = _make_gateway(
        list_pages=[
            {
                "results": page1_rows,
                "count": 120,
                "next": "http://paperless/api/trash/?page=2",
                "previous": None,
                "all": [r["id"] for r in page1_rows + page2_rows],
            },
            {
                "results": page2_rows,
                "count": 120,
                "next": None,
                "previous": "http://paperless/api/trash/?page=1",
                "all": [r["id"] for r in page1_rows + page2_rows],
            },
        ]
    )
    fake_vs = _make_vector_store()
    app.dependency_overrides[get_paperless_gateway] = lambda: fake_gw
    app.dependency_overrides[get_vector_store_optional] = lambda: fake_vs

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/trash/empty")

    assert resp.status_code == 200
    assert resp.json() == {"emptied": 120}
    expected_ids = [r["id"] for r in page1_rows + page2_rows]
    fake_gw.empty_trash.assert_awaited_once_with(doc_ids=expected_ids)
    assert fake_vs.delete_by_doc_id.await_count == 120


async def test_empty_requires_auth(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post("/api/trash/empty")
    assert resp.status_code == 401
