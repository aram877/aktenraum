"""HTTP listener so Paperless's post_consume_script can trigger extraction
within seconds of a document landing, instead of waiting for the 30s poll.

Design: the handler is a thin enqueueing layer. It validates the request, then
puts a doc id on the same asyncio.Queue the polling loop uses. The extraction
worker drains both sources uniformly. Polling stays on as a safety net for
missed webhook events (paperless workflow not yet configured, container
restart, network blip).
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

import structlog
from aiohttp import web

from .processing_state import ProcessingState

if TYPE_CHECKING:
    from .config import Settings

log = structlog.get_logger()

_QUEUE_KEY = web.AppKey("queue", asyncio.Queue)
_SECRET_KEY = web.AppKey("secret", str)
_STATE_KEY = web.AppKey("state", ProcessingState)


async def trigger_extraction(request: web.Request) -> web.Response:
    """POST /trigger/extract — body: {"document_id": <int>}.

    Returns 202 once the id is enqueued. The actual processing happens in the
    extraction worker; this endpoint never blocks on it.
    """
    expected_secret = request.app[_SECRET_KEY]
    if expected_secret:
        provided = request.headers.get("X-Aktenraum-Secret", "")
        if provided != expected_secret:
            return web.json_response({"error": "unauthorized"}, status=401)

    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "invalid json body"}, status=400)

    raw_id = body.get("document_id") if isinstance(body, dict) else None
    try:
        doc_id = int(raw_id)
    except (TypeError, ValueError):
        return web.json_response(
            {"error": "document_id must be an integer"}, status=400
        )

    queue: asyncio.Queue[int] = request.app[_QUEUE_KEY]
    queue.put_nowait(doc_id)
    log.info("webhook_enqueued", doc_id=doc_id, queue_size=queue.qsize())
    return web.json_response({"queued": doc_id}, status=202)


async def health(_: web.Request) -> web.Response:
    return web.json_response({"status": "ok"})


async def processing(request: web.Request) -> web.Response:
    """GET /processing — return the doc ids the auto-tagger is currently
    handling.

    Shape: `{"processing": [ids], "slots": {extraction, propagation, indexer}}`.
    `processing` is the deduped union — what the SPA actually polls so it can
    swap "Wartet auf KI" for a spinner on those specific rows. `slots` is
    diagnostic; keep it around for ops/debugging.

    No auth: the listener is internal-network-only (port 8001 isn't
    published to the host) so an in-cluster proxy is the only caller.
    """
    state: ProcessingState = request.app[_STATE_KEY]
    return web.json_response(
        {"processing": state.active_ids(), "slots": state.snapshot()}
    )


def make_app(
    queue: asyncio.Queue[int],
    settings: Settings,
    state: ProcessingState,
) -> web.Application:
    app = web.Application()
    app[_QUEUE_KEY] = queue
    app[_SECRET_KEY] = settings.webhook_secret
    app[_STATE_KEY] = state
    app.router.add_post("/trigger/extract", trigger_extraction)
    app.router.add_get("/health", health)
    app.router.add_get("/processing", processing)
    return app


async def run_http_server(
    queue: asyncio.Queue[int],
    settings: Settings,
    state: ProcessingState,
) -> None:
    """Long-running task: bind the listener on settings.http_port and serve
    until cancelled."""
    app = make_app(queue, settings, state)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", settings.http_port)
    await site.start()
    log.info(
        "http_server_listening",
        port=settings.http_port,
        auth_enabled=bool(settings.webhook_secret),
    )
    try:
        # Block forever — gather() in main awaits this. Cleanup runs only if
        # cancelled (e.g. on shutdown).
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()
