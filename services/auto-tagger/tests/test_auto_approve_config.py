"""Coverage for the in-process rule-store HTTP client and TTL cache."""

from __future__ import annotations

import time
from typing import Any

import httpx
import pytest
import respx
from aktenraum_core.models import DocumentType

from auto_tagger import auto_approve_config
from auto_tagger.auto_approve_config import (
    CACHE_TTL_SECONDS,
    get_rules,
    reset_cache_for_tests,
)


@pytest.fixture(autouse=True)
def _clean_cache():
    reset_cache_for_tests()
    yield
    reset_cache_for_tests()


def _ok_payload(*, enabled_types: set[str] | None = None, min_confidence: float = 0.90):
    enabled_types = enabled_types or set()
    return {
        "rules": [
            {
                "document_type": dt.value,
                "enabled": dt.value in enabled_types,
                "min_confidence": min_confidence,
                "updated_at": None,
                "updated_by": None,
            }
            for dt in DocumentType
        ]
    }


@respx.mock
async def test_fresh_fetch_populates_cache(make_settings):
    settings = make_settings(AKTENRAUM_API_URL="http://api:8002")
    route = respx.get(
        "http://api:8002/api/settings/active-auto-approve-rules"
    ).mock(return_value=httpx.Response(200, json=_ok_payload(enabled_types={"Rechnung"})))
    rules = await get_rules(settings)
    assert route.call_count == 1
    assert rules.fail_closed is False
    assert rules.by_type[DocumentType.Rechnung].enabled is True
    assert rules.by_type[DocumentType.Vertrag].enabled is False


@respx.mock
async def test_cache_hit_within_ttl_skips_http(make_settings):
    settings = make_settings(AKTENRAUM_API_URL="http://api:8002")
    route = respx.get(
        "http://api:8002/api/settings/active-auto-approve-rules"
    ).mock(return_value=httpx.Response(200, json=_ok_payload()))
    await get_rules(settings)
    await get_rules(settings)
    await get_rules(settings)
    assert route.call_count == 1


@respx.mock
async def test_cache_refetch_after_ttl_expires(make_settings, monkeypatch):
    settings = make_settings(AKTENRAUM_API_URL="http://api:8002")
    route = respx.get(
        "http://api:8002/api/settings/active-auto-approve-rules"
    ).mock(return_value=httpx.Response(200, json=_ok_payload()))
    # First call populates cache.
    await get_rules(settings)
    assert route.call_count == 1
    # Move monotonic clock forward past the TTL.
    real_monotonic = time.monotonic
    base = real_monotonic()
    monkeypatch.setattr(
        auto_approve_config.time,
        "monotonic",
        lambda: base + CACHE_TTL_SECONDS + 5.0,
    )
    await get_rules(settings)
    assert route.call_count == 2


@respx.mock
async def test_http_failure_with_populated_cache_returns_cached(
    make_settings, caplog
):
    settings = make_settings(AKTENRAUM_API_URL="http://api:8002")
    route = respx.get(
        "http://api:8002/api/settings/active-auto-approve-rules"
    ).mock(
        side_effect=[
            httpx.Response(200, json=_ok_payload(enabled_types={"Vertrag"})),
            httpx.Response(500, text="boom"),
        ]
    )
    first = await get_rules(settings)
    assert first.by_type[DocumentType.Vertrag].enabled is True
    # Force a refresh — the second response is a 500.
    # Pop the loaded-at marker so the next call goes back over HTTP.
    auto_approve_config._cache_loaded_at = None  # type: ignore[attr-defined]
    with caplog.at_level("WARNING"):
        second = await get_rules(settings)
    assert route.call_count == 2
    assert second.fail_closed is False  # cache reused, not a fail-closed default
    assert second.by_type[DocumentType.Vertrag].enabled is True


@respx.mock
async def test_http_failure_with_empty_cache_returns_fail_closed(make_settings):
    settings = make_settings(AKTENRAUM_API_URL="http://api:8002")
    respx.get(
        "http://api:8002/api/settings/active-auto-approve-rules"
    ).mock(return_value=httpx.Response(500, text="boom"))
    rules = await get_rules(settings)
    assert rules.fail_closed is True
    # Every type present and disabled at min_confidence=1.0
    for dt in DocumentType:
        rule = rules.by_type[dt]
        assert rule.enabled is False
        assert rule.min_confidence == 1.0


@respx.mock
async def test_fail_closed_does_not_mark_cache_loaded(make_settings):
    settings = make_settings(AKTENRAUM_API_URL="http://api:8002")
    route = respx.get(
        "http://api:8002/api/settings/active-auto-approve-rules"
    ).mock(
        side_effect=[
            httpx.Response(500, text="down"),
            httpx.Response(200, json=_ok_payload()),
        ]
    )
    first = await get_rules(settings)
    assert first.fail_closed is True
    # Next call must retry, NOT serve the fail-closed default from cache.
    second = await get_rules(settings)
    assert second.fail_closed is False
    assert route.call_count == 2


@respx.mock
async def test_secret_header_sent_when_configured(make_settings):
    settings = make_settings(
        AKTENRAUM_API_URL="http://api:8002", WEBHOOK_SECRET="topshh"
    )
    captured: dict[str, Any] = {}

    def _handler(request):
        captured["headers"] = dict(request.headers)
        return httpx.Response(200, json=_ok_payload())

    respx.get(
        "http://api:8002/api/settings/active-auto-approve-rules"
    ).mock(side_effect=_handler)
    await get_rules(settings)
    assert captured["headers"].get("x-aktenraum-secret") == "topshh"


@respx.mock
async def test_secret_header_omitted_when_unset(make_settings):
    settings = make_settings(AKTENRAUM_API_URL="http://api:8002")
    captured: dict[str, Any] = {}

    def _handler(request):
        captured["headers"] = dict(request.headers)
        return httpx.Response(200, json=_ok_payload())

    respx.get(
        "http://api:8002/api/settings/active-auto-approve-rules"
    ).mock(side_effect=_handler)
    await get_rules(settings)
    assert "x-aktenraum-secret" not in captured["headers"]
