"""Per-DocumentType auto-approve rules — HTTP-fetched + in-process TTL cache.

The auto-tagger used to read `AUTO_APPROVE_TYPES` + `AUTO_APPROVE_CONFIDENCE`
from env at process startup. Operator workflow was: SSH to host, edit env file,
`docker compose up -d --build auto-tagger`. The new model: the SPA's Settings
page owns the rules; this module fetches them from aktenraum-api before each
routing decision and caches for 60 seconds.

Failure modes are explicit: on HTTP error WITH a populated cache, we reuse
the cached value (graceful degradation through a brief api restart). On HTTP
error WITHOUT a cache (cold start with api unreachable), we synthesise a
fail-closed rule set so no document auto-approves until the operator's
intent can be re-fetched. This direction is asymmetric on purpose — better
to leave the user with a busy review queue than to auto-approve docs the
operator never sanctioned.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field

import httpx
import structlog
from aktenraum_core.models import AutoApproveRule, DocumentType

from .config import Settings

log = structlog.get_logger()

CACHE_TTL_SECONDS = 60.0
_FETCH_TIMEOUT_SECONDS = 2.0


@dataclass(frozen=True)
class RuleSet:
    """Active rule set + a flag identifying the fail-closed fallback.

    The fail-closed flag lets the routing function emit a distinct
    `rules_unreachable_fail_closed` reason instead of conflating with
    `type_disabled` — operators grepping logs need to tell the two apart.
    """

    by_type: dict[DocumentType, AutoApproveRule] = field(default_factory=dict)
    fail_closed: bool = False

    def get(self, doc_type: DocumentType) -> AutoApproveRule | None:
        return self.by_type.get(doc_type)


_cache: RuleSet | None = None
_cache_loaded_at: float | None = None
_lock = asyncio.Lock()


def _build_fail_closed_ruleset() -> RuleSet:
    return RuleSet(
        by_type={
            dt: AutoApproveRule(document_type=dt, enabled=False, min_confidence=1.0)
            for dt in DocumentType
        },
        fail_closed=True,
    )


async def _fetch_rules_from_api(settings: Settings) -> RuleSet:
    url = (
        f"{settings.aktenraum_api_url.rstrip('/')}"
        "/api/settings/active-auto-approve-rules"
    )
    headers: dict[str, str] = {}
    if settings.webhook_secret:
        headers["X-Aktenraum-Secret"] = settings.webhook_secret
    async with httpx.AsyncClient(timeout=_FETCH_TIMEOUT_SECONDS) as client:
        resp = await client.get(url, headers=headers)
    resp.raise_for_status()
    body = resp.json()
    by_type: dict[DocumentType, AutoApproveRule] = {}
    for entry in body.get("rules", []):
        rule = AutoApproveRule.model_validate(entry)
        by_type[rule.document_type] = rule
    return RuleSet(by_type=by_type, fail_closed=False)


async def get_rules(settings: Settings) -> RuleSet:
    """Return the active rule set.

    Uses the in-process cache when fresh (within 60s of the last successful
    fetch). On a cache miss, calls aktenraum-api. On any HTTP failure: reuse
    the cached value if populated; otherwise return a fail-closed default so
    no doc auto-approves until rules are reachable again.
    """
    global _cache, _cache_loaded_at
    async with _lock:
        now = time.monotonic()
        if (
            _cache is not None
            and _cache_loaded_at is not None
            and (now - _cache_loaded_at) < CACHE_TTL_SECONDS
        ):
            return _cache
        try:
            fresh = await _fetch_rules_from_api(settings)
        except Exception as exc:
            if _cache is not None:
                log.warning(
                    "auto_approve_rules_fetch_failed_using_cache",
                    error=str(exc),
                )
                return _cache
            log.warning(
                "auto_approve_rules_unreachable_fail_closed",
                error=str(exc),
            )
            # Don't populate `_cache_loaded_at` so the next call retries
            # instead of waiting out the TTL on a broken store.
            return _build_fail_closed_ruleset()
        _cache = fresh
        _cache_loaded_at = now
        return fresh


def reset_cache_for_tests() -> None:
    """Test helper — clear module-level cache between cases."""
    global _cache, _cache_loaded_at
    _cache = None
    _cache_loaded_at = None
