import asyncio

import pytest
from aiohttp.test_utils import TestClient, TestServer

from auto_tagger.webhook import make_app


@pytest.fixture
async def client_and_queue(make_settings):
    """Start the webhook app in-process and return (TestClient, queue)."""
    queue: asyncio.Queue[int] = asyncio.Queue()
    settings = make_settings()
    app = make_app(queue, settings)
    async with TestClient(TestServer(app)) as client:
        yield client, queue


@pytest.fixture
async def authed_client_and_queue(make_settings):
    """Same, but with WEBHOOK_SECRET=topsecret configured."""
    queue: asyncio.Queue[int] = asyncio.Queue()
    settings = make_settings(WEBHOOK_SECRET="topsecret")
    app = make_app(queue, settings)
    async with TestClient(TestServer(app)) as client:
        yield client, queue


class TestTriggerExtractionUnauthed:
    """Auth-disabled mode (empty WEBHOOK_SECRET) — every well-formed request accepted."""

    async def test_valid_post_enqueues_doc_id(self, client_and_queue):
        client, queue = client_and_queue
        resp = await client.post("/trigger/extract", json={"document_id": 42})
        assert resp.status == 202
        body = await resp.json()
        assert body == {"queued": 42}
        assert queue.get_nowait() == 42

    async def test_secret_header_ignored_when_auth_disabled(self, client_and_queue):
        client, queue = client_and_queue
        resp = await client.post(
            "/trigger/extract",
            json={"document_id": 7},
            headers={"X-Aktenraum-Secret": "anything"},
        )
        assert resp.status == 202
        assert queue.get_nowait() == 7

    async def test_invalid_json_body_returns_400(self, client_and_queue):
        client, _ = client_and_queue
        resp = await client.post(
            "/trigger/extract",
            data="not json",
            headers={"Content-Type": "application/json"},
        )
        assert resp.status == 400

    async def test_missing_document_id_returns_400(self, client_and_queue):
        client, queue = client_and_queue
        resp = await client.post("/trigger/extract", json={"foo": "bar"})
        assert resp.status == 400
        assert queue.empty()

    async def test_non_integer_document_id_returns_400(self, client_and_queue):
        client, queue = client_and_queue
        resp = await client.post("/trigger/extract", json={"document_id": "abc"})
        assert resp.status == 400
        assert queue.empty()

    async def test_string_integer_is_coerced(self, client_and_queue):
        # post_consume.sh emits a JSON int, but defensively accept stringified ones.
        client, queue = client_and_queue
        resp = await client.post("/trigger/extract", json={"document_id": "42"})
        assert resp.status == 202
        assert queue.get_nowait() == 42


class TestTriggerExtractionAuthed:
    """Auth-enabled mode — requests must carry the matching secret."""

    async def test_correct_secret_accepted(self, authed_client_and_queue):
        client, queue = authed_client_and_queue
        resp = await client.post(
            "/trigger/extract",
            json={"document_id": 1},
            headers={"X-Aktenraum-Secret": "topsecret"},
        )
        assert resp.status == 202
        assert queue.get_nowait() == 1

    async def test_missing_secret_rejected(self, authed_client_and_queue):
        client, queue = authed_client_and_queue
        resp = await client.post("/trigger/extract", json={"document_id": 1})
        assert resp.status == 401
        assert queue.empty()

    async def test_wrong_secret_rejected(self, authed_client_and_queue):
        client, queue = authed_client_and_queue
        resp = await client.post(
            "/trigger/extract",
            json={"document_id": 1},
            headers={"X-Aktenraum-Secret": "wrong"},
        )
        assert resp.status == 401
        assert queue.empty()


class TestHealth:
    async def test_health_returns_ok(self, client_and_queue):
        client, _ = client_and_queue
        resp = await client.get("/health")
        assert resp.status == 200
        assert (await resp.json()) == {"status": "ok"}
