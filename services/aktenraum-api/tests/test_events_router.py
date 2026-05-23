"""Coverage for the SSE live-counts endpoint."""

from __future__ import annotations

import importlib
from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient

from aktenraum_api.ai.deps import get_paperless_gateway
from aktenraum_api.paperless_gw import PaperlessAuthError

events_router_module = importlib.import_module("aktenraum_api.events.router")

TAG_IDS = {
    "ai-pending": 1,
    "ai-approved": 2,
}


def _make_gateway(
    *,
    tags: dict[str, int] | None = None,
    inbox_count: int = 0,
    in_flight_count: int = 0,
    trash_count: int = 0,
    raise_auth: bool = False,
):
    gw = AsyncMock()
    gw.list_tags = AsyncMock(
        return_value=tags if tags is not None else dict(TAG_IDS)
    )

    async def _search(params, page_size=None):
        if raise_auth:
            raise PaperlessAuthError("auth failed")
        ids = (params or {}).get("tags__id__in", "")
        # Disambiguate the two count calls by the tag ids in the param.
        id_list = [int(x) for x in ids.split(",") if x.strip()]
        if id_list == [TAG_IDS["ai-pending"]]:
            return {"count": inbox_count}
        if sorted(id_list) == sorted(
            [TAG_IDS["ai-pending"], TAG_IDS["ai-approved"]]
        ):
            return {"count": in_flight_count}
        return {"count": 0}

    gw.search_documents = AsyncMock(side_effect=_search)
    gw.list_trashed_documents = AsyncMock(return_value={"count": trash_count})
    return gw


async def _logged_in(client_factory):
    return await client_factory(
        BOOTSTRAP_USERNAME="admin",
        BOOTSTRAP_PASSWORD="topsecret",
        PAPERLESS_API_TOKEN="dummy",
    )


async def _login(c: AsyncClient) -> None:
    resp = await c.post(
        "/api/auth/login",
        json={"username": "admin", "password": "topsecret"},
    )
    assert resp.status_code == 200, resp.text


async def test_compute_counts_aggregates_three_queries():
    gw = _make_gateway(inbox_count=7, in_flight_count=12, trash_count=3)
    counts = await events_router_module._compute_counts(gw)
    assert counts == {"inbox": 7, "in_flight": 12, "trash": 3}


async def test_compute_counts_zero_when_tags_missing():
    gw = _make_gateway(tags={}, inbox_count=99, in_flight_count=99, trash_count=4)
    counts = await events_router_module._compute_counts(gw)
    assert counts["inbox"] == 0
    assert counts["in_flight"] == 0
    assert counts["trash"] == 4


async def test_compute_counts_propagates_auth_error():
    gw = _make_gateway(raise_auth=True)
    with pytest.raises(PaperlessAuthError):
        await events_router_module._compute_counts(gw)


async def test_stream_counts_requires_auth(client_factory):
    app, _s, transport = await _logged_in(client_factory)
    gw = _make_gateway()
    app.dependency_overrides[get_paperless_gateway] = lambda: gw
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/events/counts")
    assert resp.status_code == 401


async def test_stream_counts_emits_initial_snapshot(client_factory, monkeypatch):
    """First emit on connect is the current snapshot — no need to wait
    a full poll interval. We force a near-zero interval so the test
    doesn't hang waiting on the loop."""
    monkeypatch.setattr(events_router_module, "POLL_INTERVAL_SECONDS", 0.01)
    # Cap the stream to one emit so the test doesn't hang under in-
    # process ASGI (no real disconnect signal).
    monkeypatch.setattr(events_router_module, "_MAX_EMITS", 1)
    app, _s, transport = await _logged_in(client_factory)
    gw = _make_gateway(inbox_count=2, in_flight_count=5, trash_count=1)
    app.dependency_overrides[get_paperless_gateway] = lambda: gw
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            # Use stream() so we can read the first event without
            # waiting for the connection to close.
            async with c.stream("GET", "/api/events/counts") as resp:
                assert resp.status_code == 200
                assert resp.headers["content-type"].startswith("text/event-stream")
                # Read until we get a data: line OR fail the test.
                first_data: str | None = None
                async for chunk in resp.aiter_text():
                    for line in chunk.splitlines():
                        if line.startswith("data: "):
                            first_data = line[len("data: ") :]
                            break
                    if first_data is not None:
                        break
    assert first_data is not None
    import json

    payload = json.loads(first_data)
    assert payload == {"inbox": 2, "in_flight": 5, "trash": 1}
