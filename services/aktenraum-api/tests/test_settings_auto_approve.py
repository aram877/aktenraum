"""Coverage for the per-DocumentType auto-approve rule endpoints."""

from __future__ import annotations

from aktenraum_core.models import DocumentType
from httpx import AsyncClient

EXPECTED_TYPES = sorted(dt.value for dt in DocumentType)
NUM_TYPES = len(EXPECTED_TYPES)


def _full_rule_payload(
    *,
    enabled_types: set[str] | None = None,
    min_confidence: float = 0.90,
) -> dict:
    enabled_types = enabled_types or set()
    return {
        "rules": [
            {
                "document_type": dt,
                "enabled": dt in enabled_types,
                "min_confidence": min_confidence,
            }
            for dt in EXPECTED_TYPES
        ]
    }


async def _login(client: AsyncClient, username: str, password: str) -> None:
    resp = await client.post(
        "/api/auth/login", json={"username": username, "password": password}
    )
    assert resp.status_code == 200


async def _logged_in_app(client_factory, **overrides):
    app, settings, transport = await client_factory(
        BOOTSTRAP_USERNAME="admin",
        BOOTSTRAP_PASSWORD="topsecret",
        **overrides,
    )
    return app, settings, transport


async def test_get_returns_seeded_26_rows(client_factory):
    app, _settings, transport = await _logged_in_app(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c, "admin", "topsecret")
            resp = await c.get("/api/settings/auto-approve")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["rules"]) == NUM_TYPES
    types_returned = [r["document_type"] for r in body["rules"]]
    assert types_returned == EXPECTED_TYPES  # alphabetic, no duplicates
    for entry in body["rules"]:
        assert entry["enabled"] is False
        assert entry["min_confidence"] == 0.90
        assert entry["updated_at"] is None
        assert entry["updated_by"] is None


async def test_get_requires_auth(client_factory):
    app, _settings, transport = await _logged_in_app(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/settings/auto-approve")
    assert resp.status_code == 401


async def test_put_happy_path_updates_rows(client_factory):
    app, _settings, transport = await _logged_in_app(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c, "admin", "topsecret")
            payload = _full_rule_payload(
                enabled_types={"Rechnung", "Kontoauszug"}, min_confidence=0.85
            )
            put_resp = await c.put("/api/settings/auto-approve", json=payload)
            assert put_resp.status_code == 200
            put_body = put_resp.json()
            rechnung = next(
                r for r in put_body["rules"] if r["document_type"] == "Rechnung"
            )
            assert rechnung["enabled"] is True
            assert rechnung["min_confidence"] == 0.85
            assert rechnung["updated_by"] == "admin"
            assert rechnung["updated_at"] is not None
            vertrag = next(
                r for r in put_body["rules"] if r["document_type"] == "Vertrag"
            )
            assert vertrag["enabled"] is False
            # GET reflects the change.
            get_resp = await c.get("/api/settings/auto-approve")
    assert get_resp.status_code == 200
    rechnung_get = next(
        r for r in get_resp.json()["rules"] if r["document_type"] == "Rechnung"
    )
    assert rechnung_get["enabled"] is True
    assert rechnung_get["min_confidence"] == 0.85


async def test_put_missing_type_rejected(client_factory):
    app, _settings, transport = await _logged_in_app(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c, "admin", "topsecret")
            payload = _full_rule_payload()
            payload["rules"] = [
                r for r in payload["rules"] if r["document_type"] != "Rechnung"
            ]
            resp = await c.put("/api/settings/auto-approve", json=payload)
    # Pydantic model_validator -> 422 in FastAPI.
    assert resp.status_code == 422
    assert "Missing" in resp.text or "Rechnung" in resp.text


async def test_put_duplicate_type_rejected(client_factory):
    app, _settings, transport = await _logged_in_app(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c, "admin", "topsecret")
            payload = _full_rule_payload()
            payload["rules"].append(
                {"document_type": "Vertrag", "enabled": True, "min_confidence": 0.9}
            )
            resp = await c.put("/api/settings/auto-approve", json=payload)
    assert resp.status_code == 422
    assert "Duplicate" in resp.text or "Vertrag" in resp.text


async def test_put_unknown_type_rejected(client_factory):
    app, _settings, transport = await _logged_in_app(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c, "admin", "topsecret")
            payload = _full_rule_payload()
            payload["rules"][0]["document_type"] = "NichtImEnum"
            resp = await c.put("/api/settings/auto-approve", json=payload)
    assert resp.status_code == 422


async def test_put_min_confidence_out_of_range_rejected(client_factory):
    app, _settings, transport = await _logged_in_app(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c, "admin", "topsecret")
            payload = _full_rule_payload()
            payload["rules"][0]["min_confidence"] = 1.5
            resp = await c.put("/api/settings/auto-approve", json=payload)
    assert resp.status_code == 422


async def test_put_requires_auth(client_factory):
    app, _settings, transport = await _logged_in_app(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.put("/api/settings/auto-approve", json=_full_rule_payload())
    assert resp.status_code == 401


async def test_internal_endpoint_with_correct_secret_returns_200(client_factory):
    app, _settings, transport = await _logged_in_app(
        client_factory, WEBHOOK_SECRET="topshhh"
    )
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get(
                "/api/settings/active-auto-approve-rules",
                headers={"X-Aktenraum-Secret": "topshhh"},
            )
    assert resp.status_code == 200
    assert len(resp.json()["rules"]) == NUM_TYPES


async def test_internal_endpoint_with_wrong_secret_returns_401(client_factory):
    app, _settings, transport = await _logged_in_app(
        client_factory, WEBHOOK_SECRET="topshhh"
    )
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get(
                "/api/settings/active-auto-approve-rules",
                headers={"X-Aktenraum-Secret": "wrong"},
            )
    assert resp.status_code == 401


async def test_internal_endpoint_missing_header_returns_401_when_secret_set(
    client_factory,
):
    app, _settings, transport = await _logged_in_app(
        client_factory, WEBHOOK_SECRET="topshhh"
    )
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/settings/active-auto-approve-rules")
    assert resp.status_code == 401


async def test_internal_endpoint_open_when_secret_empty(client_factory):
    app, _settings, transport = await _logged_in_app(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/settings/active-auto-approve-rules")
    assert resp.status_code == 200
    assert len(resp.json()["rules"]) == NUM_TYPES


async def test_reconciler_reinserts_missing_row(client_factory):
    """Manually delete a row and confirm the next lifespan re-inserts it
    with the seed defaults and doesn't touch existing rows."""
    from sqlalchemy.ext.asyncio import create_async_engine

    app, settings, transport = await _logged_in_app(client_factory)
    db_url = settings.database_url
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c, "admin", "topsecret")
            # Touch a row so we can later verify it WAS NOT clobbered.
            payload = _full_rule_payload(
                enabled_types={"Vertrag"}, min_confidence=0.77
            )
            put_resp = await c.put("/api/settings/auto-approve", json=payload)
            assert put_resp.status_code == 200
            vertrag_before = next(
                r for r in put_resp.json()["rules"] if r["document_type"] == "Vertrag"
            )
            vertrag_updated_at = vertrag_before["updated_at"]
    # Out-of-band delete one row.
    engine = create_async_engine(db_url, future=True)
    async with engine.begin() as conn:
        from sqlalchemy import text

        await conn.execute(
            text("DELETE FROM auto_approve_rules WHERE document_type = 'Rechnung'")
        )
    await engine.dispose()

    # Re-enter lifespan — reconciler should re-insert Rechnung.
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c, "admin", "topsecret")
            resp = await c.get("/api/settings/auto-approve")
    rules = {r["document_type"]: r for r in resp.json()["rules"]}
    rechnung_after = rules["Rechnung"]
    assert rechnung_after["enabled"] is False
    assert rechnung_after["min_confidence"] == 0.90
    assert rechnung_after["updated_by"] is None
    vertrag_after = rules["Vertrag"]
    assert vertrag_after["enabled"] is True
    assert vertrag_after["min_confidence"] == 0.77
    # SQLite drops the trailing 'Z' on roundtrip; the wall-clock value is
    # unchanged, which is what we actually care about (reconciler didn't
    # touch the existing row).
    assert vertrag_after["updated_at"].rstrip("Z") == vertrag_updated_at.rstrip("Z")
