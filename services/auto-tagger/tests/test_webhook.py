import asyncio

import pytest
from aiohttp.test_utils import TestClient, TestServer

from auto_tagger.processing_state import ProcessingState
from auto_tagger.webhook import make_app


@pytest.fixture
async def client_and_queues(make_settings):
    """Start the webhook app in-process and return
    (TestClient, extraction_queue, propagation_queue, state)."""
    extraction_queue: asyncio.Queue[int] = asyncio.Queue()
    propagation_queue: asyncio.Queue[int] = asyncio.Queue()
    settings = make_settings()
    state = ProcessingState()
    app = make_app(extraction_queue, propagation_queue, settings, state)
    async with TestClient(TestServer(app)) as client:
        yield client, extraction_queue, propagation_queue, state


@pytest.fixture
async def authed_client_and_queues(make_settings):
    """Same, but with WEBHOOK_SECRET=topsecret configured."""
    extraction_queue: asyncio.Queue[int] = asyncio.Queue()
    propagation_queue: asyncio.Queue[int] = asyncio.Queue()
    settings = make_settings(WEBHOOK_SECRET="topsecret")
    state = ProcessingState()
    app = make_app(extraction_queue, propagation_queue, settings, state)
    async with TestClient(TestServer(app)) as client:
        yield client, extraction_queue, propagation_queue, state


@pytest.fixture
async def bounded_propagation_queue(make_settings):
    """Propagation queue with maxsize=1 so we can deterministically force
    the 503 path in tests."""
    extraction_queue: asyncio.Queue[int] = asyncio.Queue()
    propagation_queue: asyncio.Queue[int] = asyncio.Queue(maxsize=1)
    settings = make_settings()
    state = ProcessingState()
    app = make_app(extraction_queue, propagation_queue, settings, state)
    async with TestClient(TestServer(app)) as client:
        yield client, propagation_queue


class TestTriggerExtractionUnauthed:
    """Auth-disabled mode (empty WEBHOOK_SECRET) — every well-formed request accepted."""

    async def test_valid_post_enqueues_doc_id(self, client_and_queues):
        client, queue, _propq, _state = client_and_queues
        resp = await client.post("/trigger/extract", json={"document_id": 42})
        assert resp.status == 202
        body = await resp.json()
        assert body == {"queued": 42}
        assert queue.get_nowait() == 42

    async def test_secret_header_ignored_when_auth_disabled(self, client_and_queues):
        client, queue, _propq, _state = client_and_queues
        resp = await client.post(
            "/trigger/extract",
            json={"document_id": 7},
            headers={"X-Aktenraum-Secret": "anything"},
        )
        assert resp.status == 202
        assert queue.get_nowait() == 7

    async def test_invalid_json_body_returns_400(self, client_and_queues):
        client, _, _propq, _state = client_and_queues
        resp = await client.post(
            "/trigger/extract",
            data="not json",
            headers={"Content-Type": "application/json"},
        )
        assert resp.status == 400

    async def test_missing_document_id_returns_400(self, client_and_queues):
        client, queue, _propq, _state = client_and_queues
        resp = await client.post("/trigger/extract", json={"foo": "bar"})
        assert resp.status == 400
        assert queue.empty()

    async def test_non_integer_document_id_returns_400(self, client_and_queues):
        client, queue, _propq, _state = client_and_queues
        resp = await client.post("/trigger/extract", json={"document_id": "abc"})
        assert resp.status == 400
        assert queue.empty()

    async def test_string_integer_is_coerced(self, client_and_queues):
        # post_consume.sh emits a JSON int, but defensively accept stringified ones.
        client, queue, _propq, _state = client_and_queues
        resp = await client.post("/trigger/extract", json={"document_id": "42"})
        assert resp.status == 202
        assert queue.get_nowait() == 42


class TestTriggerExtractionAuthed:
    """Auth-enabled mode — requests must carry the matching secret."""

    async def test_correct_secret_accepted(self, authed_client_and_queues):
        client, queue, _propq, _state = authed_client_and_queues
        resp = await client.post(
            "/trigger/extract",
            json={"document_id": 1},
            headers={"X-Aktenraum-Secret": "topsecret"},
        )
        assert resp.status == 202
        assert queue.get_nowait() == 1

    async def test_missing_secret_rejected(self, authed_client_and_queues):
        client, queue, _propq, _state = authed_client_and_queues
        resp = await client.post("/trigger/extract", json={"document_id": 1})
        assert resp.status == 401
        assert queue.empty()

    async def test_wrong_secret_rejected(self, authed_client_and_queues):
        client, queue, _propq, _state = authed_client_and_queues
        resp = await client.post(
            "/trigger/extract",
            json={"document_id": 1},
            headers={"X-Aktenraum-Secret": "wrong"},
        )
        assert resp.status == 401
        assert queue.empty()


class TestTriggerPropagationUnauthed:
    """/trigger/propagate mirrors /trigger/extract but targets the
    propagation queue. aktenraum-api's approve endpoint fires this so
    propagation runs immediately rather than waiting on the 30s poller."""

    async def test_valid_post_enqueues_doc_id_on_propagation_queue(
        self, client_and_queues
    ):
        client, extq, propq, _state = client_and_queues
        resp = await client.post("/trigger/propagate", json={"document_id": 42})
        assert resp.status == 202
        body = await resp.json()
        assert body == {"queued": 42}
        # Importantly: the propagation trigger MUST land in the propagation
        # queue, not the extraction one — otherwise the worker won't pick it up.
        assert propq.get_nowait() == 42
        assert extq.empty()

    async def test_invalid_json_body_returns_400(self, client_and_queues):
        client, _, propq, _state = client_and_queues
        resp = await client.post(
            "/trigger/propagate",
            data="not json",
            headers={"Content-Type": "application/json"},
        )
        assert resp.status == 400
        assert propq.empty()

    async def test_missing_document_id_returns_400(self, client_and_queues):
        client, _extq, propq, _state = client_and_queues
        resp = await client.post("/trigger/propagate", json={"foo": "bar"})
        assert resp.status == 400
        assert propq.empty()

    async def test_non_integer_document_id_returns_400(self, client_and_queues):
        client, _extq, propq, _state = client_and_queues
        resp = await client.post("/trigger/propagate", json={"document_id": "abc"})
        assert resp.status == 400
        assert propq.empty()

    async def test_queue_full_returns_503(self, bounded_propagation_queue):
        client, propq = bounded_propagation_queue
        # Saturate the queue first (maxsize=1).
        propq.put_nowait(99)
        resp = await client.post("/trigger/propagate", json={"document_id": 100})
        assert resp.status == 503
        body = await resp.json()
        assert "queue full" in body["error"]


class TestTriggerPropagationAuthed:
    """The secret check is shared via _check_secret — these tests assert
    /trigger/propagate honours WEBHOOK_SECRET identically to /trigger/extract."""

    async def test_correct_secret_accepted(self, authed_client_and_queues):
        client, _extq, propq, _state = authed_client_and_queues
        resp = await client.post(
            "/trigger/propagate",
            json={"document_id": 1},
            headers={"X-Aktenraum-Secret": "topsecret"},
        )
        assert resp.status == 202
        assert propq.get_nowait() == 1

    async def test_missing_secret_rejected(self, authed_client_and_queues):
        client, _extq, propq, _state = authed_client_and_queues
        resp = await client.post("/trigger/propagate", json={"document_id": 1})
        assert resp.status == 401
        assert propq.empty()

    async def test_wrong_secret_rejected(self, authed_client_and_queues):
        client, _extq, propq, _state = authed_client_and_queues
        resp = await client.post(
            "/trigger/propagate",
            json={"document_id": 1},
            headers={"X-Aktenraum-Secret": "wrong"},
        )
        assert resp.status == 401
        assert propq.empty()


class TestHealth:
    async def test_health_returns_ok(self, client_and_queues):
        client, _extq, _propq, _state = client_and_queues
        resp = await client.get("/health")
        assert resp.status == 200
        assert (await resp.json()) == {"status": "ok"}


class TestProcessing:
    """`GET /processing` reflects the live ProcessingState that each
    worker writes into. The SPA polls it to swap the generic "Wartet
    auf KI" badge for a spinner on the specific doc in flight."""

    async def test_idle_returns_empty(self, client_and_queues):
        client, _extq, _propq, _state = client_and_queues
        resp = await client.get("/processing")
        assert resp.status == 200
        body = await resp.json()
        assert body == {
            "processing": [],
            "slots": {"extraction": None, "propagation": None, "indexer": None},
        }

    async def test_active_slots_surface_in_processing_list(self, client_and_queues):
        client, _extq, _propq, state = client_and_queues
        state.extraction = 42
        state.indexer = 17
        resp = await client.get("/processing")
        body = await resp.json()
        assert sorted(body["processing"]) == [17, 42]
        assert body["slots"] == {
            "extraction": 42,
            "propagation": None,
            "indexer": 17,
        }

    async def test_same_doc_in_two_slots_dedupes(self, client_and_queues):
        # Race: a doc finishes propagation and is immediately enqueued for
        # indexing. The dedupe keeps the SPA from seeing the id twice.
        client, _extq, _propq, state = client_and_queues
        state.propagation = 9
        state.indexer = 9
        resp = await client.get("/processing")
        body = await resp.json()
        assert body["processing"] == [9]
