from httpx import AsyncClient


async def _logged_in_client(client_factory, *, username="admin", password="topsecret"):
    app, settings, transport = await client_factory(
        BOOTSTRAP_USERNAME=username, BOOTSTRAP_PASSWORD=password
    )
    return app, settings, transport


async def test_login_success_sets_cookie(client_factory):
    app, settings, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post(
                "/api/auth/login",
                json={"username": "admin", "password": "topsecret"},
            )
    assert resp.status_code == 200
    assert resp.json() == {"username": "admin"}
    set_cookie = resp.headers.get("set-cookie", "")
    assert settings.cookie_name in set_cookie
    assert "HttpOnly" in set_cookie
    assert "samesite=lax" in set_cookie.lower()


async def test_login_wrong_password_returns_401(client_factory):
    app, _settings, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post(
                "/api/auth/login",
                json={"username": "admin", "password": "WRONG"},
            )
    assert resp.status_code == 401
    assert "set-cookie" not in resp.headers


async def test_login_unknown_user_returns_401(client_factory):
    app, _settings, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post(
                "/api/auth/login",
                json={"username": "ghost", "password": "topsecret"},
            )
    assert resp.status_code == 401


async def test_me_requires_cookie(client_factory):
    app, _settings, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/auth/me")
    assert resp.status_code == 401


async def test_me_returns_user_with_valid_cookie(client_factory):
    app, _settings, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            login_resp = await c.post(
                "/api/auth/login",
                json={"username": "admin", "password": "topsecret"},
            )
            assert login_resp.status_code == 200
            # AsyncClient retains cookies across calls in the same instance.
            me_resp = await c.get("/api/auth/me")
    assert me_resp.status_code == 200
    assert me_resp.json() == {"username": "admin"}


async def test_logout_clears_cookie(client_factory):
    app, settings, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await c.post(
                "/api/auth/login",
                json={"username": "admin", "password": "topsecret"},
            )
            logout_resp = await c.post("/api/auth/logout")
            me_resp_after = await c.get("/api/auth/me")
    assert logout_resp.status_code == 204
    set_cookie = logout_resp.headers.get("set-cookie", "")
    assert settings.cookie_name in set_cookie
    # Cleared cookies have Max-Age=0 (or expires in the past).
    assert "Max-Age=0" in set_cookie or 'expires=Thu, 01 Jan 1970' in set_cookie.lower()
    assert me_resp_after.status_code == 401


async def test_change_password_happy_path(client_factory):
    app, settings, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await c.post(
                "/api/auth/login",
                json={"username": "admin", "password": "topsecret"},
            )
            change_resp = await c.post(
                "/api/auth/change-password",
                json={
                    "current_password": "topsecret",
                    "new_password": "newsecret123",
                },
            )
            assert change_resp.status_code == 204
            set_cookie = change_resp.headers.get("set-cookie", "")
            assert settings.cookie_name in set_cookie
            assert (
                "Max-Age=0" in set_cookie
                or "expires=Thu, 01 Jan 1970" in set_cookie.lower()
            )
            me_after = await c.get("/api/auth/me")
            assert me_after.status_code == 401

        async with AsyncClient(transport=transport, base_url="http://test") as fresh:
            old_login = await fresh.post(
                "/api/auth/login",
                json={"username": "admin", "password": "topsecret"},
            )
            assert old_login.status_code == 401
            new_login = await fresh.post(
                "/api/auth/login",
                json={"username": "admin", "password": "newsecret123"},
            )
            assert new_login.status_code == 200


async def test_change_password_wrong_current(client_factory):
    app, _settings, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await c.post(
                "/api/auth/login",
                json={"username": "admin", "password": "topsecret"},
            )
            change_resp = await c.post(
                "/api/auth/change-password",
                json={
                    "current_password": "WRONG",
                    "new_password": "newsecret123",
                },
            )
            assert change_resp.status_code == 401
            me_after = await c.get("/api/auth/me")
            assert me_after.status_code == 200

        async with AsyncClient(transport=transport, base_url="http://test") as fresh:
            still_old = await fresh.post(
                "/api/auth/login",
                json={"username": "admin", "password": "topsecret"},
            )
            assert still_old.status_code == 200


async def test_change_password_new_equals_current(client_factory):
    app, _settings, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await c.post(
                "/api/auth/login",
                json={"username": "admin", "password": "topsecret"},
            )
            change_resp = await c.post(
                "/api/auth/change-password",
                json={
                    "current_password": "topsecret",
                    "new_password": "topsecret",
                },
            )
            assert change_resp.status_code == 400
            me_after = await c.get("/api/auth/me")
            assert me_after.status_code == 200


async def test_change_password_unauthenticated(client_factory):
    app, _settings, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            change_resp = await c.post(
                "/api/auth/change-password",
                json={
                    "current_password": "topsecret",
                    "new_password": "newsecret123",
                },
            )
            assert change_resp.status_code == 401

        async with AsyncClient(transport=transport, base_url="http://test") as fresh:
            login_resp = await fresh.post(
                "/api/auth/login",
                json={"username": "admin", "password": "topsecret"},
            )
            assert login_resp.status_code == 200


async def test_change_password_too_short(client_factory):
    app, _settings, transport = await _logged_in_client(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await c.post(
                "/api/auth/login",
                json={"username": "admin", "password": "topsecret"},
            )
            change_resp = await c.post(
                "/api/auth/change-password",
                json={
                    "current_password": "topsecret",
                    "new_password": "short",
                },
            )
            assert change_resp.status_code == 422
            me_after = await c.get("/api/auth/me")
            assert me_after.status_code == 200
