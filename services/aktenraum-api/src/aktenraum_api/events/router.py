"""Live counts via Server-Sent Events.

`GET /api/events/counts` streams `data: {...}\n\n` events whenever the
inbox / in-flight / trash counts change. Replaces three independent
polling timers in the SPA (Nav badges) with one push-based stream so
the user sees state changes within seconds of them happening on the
backend — no manual refresh.

Why not WebSockets? SSE is one-directional (server → client), which is
exactly what we need: the client never talks back. SSE rides on HTTP,
goes through nginx without special config, and reconnects automatically
in the browser via the native EventSource API.

Why per-connection server-side polling instead of a shared pub/sub?
Single-user product. One or two SPAs open at once. Three Paperless
calls every 3s per connection is trivial. If the user base ever grows,
this becomes one shared task + a fanout — but premature today.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from ..ai.deps import get_paperless_gateway
from ..auth.deps import get_current_user
from ..db.models import User
from ..paperless_gw import PaperlessAuthError, PaperlessGateway

router = APIRouter(prefix="/events", tags=["events"])

# How often to poll Paperless for fresh counts. 3s is the responsiveness
# target; anything snappier shows up as the user noticing the badge tick
# AS they cross from one page to another.
POLL_INTERVAL_SECONDS = 3.0

# Send a heartbeat comment every N seconds even if no counts changed —
# nginx defaults `proxy_read_timeout` to 60s and will drop idle SSE
# connections otherwise. 25s leaves comfortable margin.
HEARTBEAT_INTERVAL_SECONDS = 25.0

# Test escape hatch: set to a small integer to make the stream terminate
# after that many emits. None in production = unbounded.
_MAX_EMITS: int | None = None

# In-flight = docs the auto-tagger or propagator is currently working on.
# Mirrors the definition in `documents/router.py::_IN_FLIGHT_TAGS`.
_IN_FLIGHT_TAGS = ("ai-pending", "ai-approved")
_PENDING_TAG = "ai-pending"


async def _compute_counts(gateway: PaperlessGateway) -> dict[str, int]:
    """One pass: inbox + in-flight + trash counts.

    All three queries fan out in parallel via asyncio.gather so the
    poll loop's effective cadence is bounded by the slowest single
    request, not the sum.
    """
    tags = await gateway.list_tags()
    pending_id = tags.get(_PENDING_TAG)
    flight_ids = [tags[name] for name in _IN_FLIGHT_TAGS if name in tags]

    async def _inbox_count() -> int:
        if pending_id is None:
            return 0
        payload = await gateway.search_documents(
            {"tags__id__in": str(pending_id)}, page_size=1
        )
        return int(payload.get("count", 0))

    async def _in_flight_count() -> int:
        if not flight_ids:
            return 0
        payload = await gateway.search_documents(
            {"tags__id__in": ",".join(str(i) for i in flight_ids)},
            page_size=1,
        )
        return int(payload.get("count", 0))

    async def _trash_count() -> int:
        payload = await gateway.list_trashed_documents(page=1, page_size=1)
        return int(payload.get("count", 0))

    inbox, in_flight, trashed = await asyncio.gather(
        _inbox_count(), _in_flight_count(), _trash_count()
    )
    return {"inbox": inbox, "in_flight": in_flight, "trash": trashed}


def _format_event(payload: dict[str, int]) -> bytes:
    return f"data: {json.dumps(payload)}\n\n".encode()


@router.get("/counts")
async def stream_counts(
    request: Request,
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
) -> StreamingResponse:
    """Server-Sent Events stream of {inbox, in_flight, trash} counts.

    Emits one event immediately on connect (initial snapshot) and then
    one event per change. Heartbeats every 25s keep the connection alive
    through nginx. Stops cleanly when the client disconnects.
    """

    async def gen():
        last_payload: dict[str, int] | None = None
        last_emit = 0.0
        emits = 0
        # _MAX_EMITS = None means unbounded (production). Tests set a small
        # int to force the loop to exit after N emits — in-process ASGI
        # doesn't propagate disconnects so a truly-infinite loop would
        # hang the test runner.
        while _MAX_EMITS is None or emits < _MAX_EMITS:
            if await request.is_disconnected():
                return
            try:
                payload = await _compute_counts(gateway)
            except PaperlessAuthError:
                # Token rotated / removed. Emit a sentinel and stop —
                # the client will reconnect and see the same 401 on the
                # auth dependency, at which point it knows to back off.
                yield b"event: error\ndata: paperless_auth\n\n"
                return
            except Exception:
                # Any other transient failure: keep the stream alive
                # but emit a "stale" comment so the client can decide
                # whether to surface it. Will retry on the next tick.
                yield b": stale\n\n"
            else:
                now = asyncio.get_event_loop().time()
                changed = payload != last_payload
                stale_heartbeat = (now - last_emit) >= HEARTBEAT_INTERVAL_SECONDS
                if changed or last_payload is None or stale_heartbeat:
                    yield _format_event(payload)
                    last_payload = payload
                    last_emit = now
                    emits += 1
            await asyncio.sleep(POLL_INTERVAL_SECONDS)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # Disable nginx response buffering for this endpoint so
            # events reach the browser as soon as they're yielded.
            "X-Accel-Buffering": "no",
        },
    )
