"""Thin best-effort HTTP client for the auto-tagger's /trigger/* webhooks.

Two callers today:
  - `documents/router.py::reprocess` fires /trigger/extract after clearing
    lifecycle tags so re-extraction starts immediately instead of waiting
    on the 30s poll.
  - `inbox/service.py::approve` fires /trigger/propagate after the
    lifecycle-tag swap so propagation runs in <1s rather than up to 30s.

Both are non-critical: the auto-tagger's safety-net poller still picks
up the work if the ping fails. We log warnings on failure and never
raise — the calling request must succeed regardless.
"""

from __future__ import annotations

from typing import Literal

import httpx
import structlog

from .config import Settings

log = structlog.get_logger()

Trigger = Literal["extract", "propagate"]


async def ping_auto_tagger(
    settings: Settings,
    doc_id: int,
    *,
    trigger: Trigger,
    timeout: float = 10.0,
) -> bool:
    """POST `{document_id: doc_id}` to the auto-tagger's trigger webhook.

    Returns True on 2xx, False on any error (skipped URL, timeout, 4xx,
    5xx, network failure). Never raises — the caller already committed
    the source-of-truth state change (tag swap, custom-field PATCH) and
    this ping is purely the optimistic "go faster" lever.

    `timeout` is bounded short for the propagation path (2s) because
    aktenraum-api's approve handler awaits this call inline before
    returning the InboxDetail — we don't want a slow auto-tagger to
    stall the SPA. The extract path uses the default 10s since reprocess
    is a slower user action overall.
    """
    if not settings.auto_tagger_url:
        return False
    headers = {"Content-Type": "application/json"}
    if settings.webhook_secret:
        headers["X-Aktenraum-Secret"] = settings.webhook_secret
    url = f"{settings.auto_tagger_url.rstrip('/')}/trigger/{trigger}"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                url, json={"document_id": doc_id}, headers=headers
            )
            if resp.status_code >= 400:
                log.warning(
                    "auto_tagger_ping_rejected",
                    trigger=trigger,
                    doc_id=doc_id,
                    status=resp.status_code,
                    body=resp.text[:200],
                )
                return False
            return True
    except Exception as e:
        log.warning(
            "auto_tagger_ping_failed",
            trigger=trigger,
            doc_id=doc_id,
            error=str(e),
        )
        return False
