---
name: fastapi-route-pattern
description: Use when adding or modifying any route in services/aktenraum-api (the BFF layer). Documents the standard router/service/schemas layout, the dependency-injection order, the gateway-error → HTTP-status mapping, CSRF middleware compatibility, the get-document-then-patch idiom, and the test fixture pattern. Triggers when editing services/aktenraum-api/src/aktenraum_api/*/router.py, when creating a new endpoint area, or when investigating an HTTP 4xx/5xx that doesn't match the gateway's actual error.
---

# FastAPI route pattern (aktenraum-api)

`aktenraum-api` is the BFF (Backend-For-Frontend) layer. Every endpoint follows the same shape. This skill is the template.

---

## Directory layout

Routes are grouped by area under `services/aktenraum-api/src/aktenraum_api/`:

```
ai/
  ├─ router.py        ← FastAPI routes
  ├─ schemas.py       ← Pydantic request/response shapes
  ├─ translate.py     ← business logic / pure functions
  ├─ retrieval.py     ← RAG helpers
  └─ deps.py          ← area-specific dependencies (get_paperless_gateway, etc.)

inbox/
  ├─ router.py
  ├─ schemas.py
  └─ service.py       ← business logic; takes gateway + doc_id and does the work
```

Convention:

- **`router.py`** — only HTTP wiring (path, method, deps, error mapping). No business logic.
- **`service.py`** (or `translate.py` / `retrieval.py` for AI subdirs) — pure-ish functions that take dependencies as arguments. Easy to unit-test without an HTTP layer.
- **`schemas.py`** — Pydantic models for the request body, response body, and any shared shapes.
- **`deps.py`** — area-specific `Depends` providers (the cross-cutting `get_current_user`, `get_settings`, `get_session` live in `auth/deps.py` and `db/session.py`).

When adding a new area (e.g. an `exports/` endpoint group), create the whole directory layout — don't put routers in `aktenraum_api/exports_router.py` at the top level.

---

## Wiring into the FastAPI app

Every router gets included in `main.py` with the `/api` prefix:

```python
# services/aktenraum-api/src/aktenraum_api/main.py
from .exports import router as exports_router
# ...
app.include_router(exports_router, prefix="/api")
```

The router itself declares its own sub-prefix:

```python
# services/aktenraum-api/src/aktenraum_api/exports/router.py
router = APIRouter(prefix="/exports", tags=["exports"])
```

Final path: `/api/exports/<...>`. Tags drive the OpenAPI grouping at `/api/docs`.

---

## The dependency-injection order

Every endpoint takes its deps in this order:

```python
@router.post("/{doc_id}/some-action", response_model=SomeResponse)
async def some_action(
    doc_id: int,
    body: SomeRequest,                                            # path + body first
    _user: User = Depends(get_current_user),                      # auth check
    settings: Settings = Depends(get_settings),                   # config (only if you need it)
    gateway: PaperlessGateway = Depends(get_paperless_gateway),   # Paperless access
    session: AsyncSession = Depends(get_session),                 # DB session (only if you need it)
) -> SomeResponse:
    ...
```

Rules:

- **`_user: User = Depends(get_current_user)`** — auth check. Even when you don't read the user, declare it. The dependency raises 401 if the cookie is missing/invalid. Underscore-prefixed since we don't use it.
- **`get_paperless_gateway`** lives in `ai/deps.py`. It returns `app.state.paperless_gateway` and raises 503 if it isn't configured. Don't reach `request.app.state.paperless_gateway` directly.
- **`get_session`** is the SQLAlchemy async session for the `aktenraum` DB. Only used by `auth/`, `settings/`, `type_fields/`. Most areas don't need it.
- Path/body params come first because FastAPI binds them positionally.

---

## Gateway-error → HTTP-status mapping (mandatory)

Every gateway call that can raise typed errors must map them to HTTP responses:

```python
from ..paperless_gw import (
    PaperlessAuthError,
    PaperlessConflictError,
    PaperlessGateway,
    PaperlessNotFoundError,
)

try:
    return await service.do_something(gateway, doc_id, body)
except PaperlessNotFoundError as e:
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Document {doc_id} not found",
    ) from e
except PaperlessAuthError as e:
    raise HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail="Paperless rejected the API token",
    ) from e
except PaperlessConflictError as e:
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=f"Document {doc_id} was modified concurrently. Refresh and try again.",
    ) from e
```

The mapping is:

| Gateway exception | HTTP status | When |
| --- | --- | --- |
| `PaperlessNotFoundError` | `404` | Paperless returned 404 (doc doesn't exist) |
| `PaperlessAuthError` | `502` | Paperless returned 401/403 (our token is wrong) — bad gateway, not unauthorized |
| `PaperlessConflictError` | `409` | `swap_lifecycle_tag` couldn't win the TOCTOU retry — client should refresh and retry |
| `httpx.HTTPStatusError` (any other) | let it bubble | FastAPI returns 500; gateway logs the body via `paperless_patch_rejected` etc. |

In `inbox/router.py` these mappings are factored into helpers `_not_found(doc_id)`, `_bad_gateway()`, `_conflict(doc_id)`. For a new router area, copy that pattern.

---

## CSRF middleware compatibility

The `CSRFMiddleware` (`middleware.py`, applied in `main.py`) blocks state-changing requests with `Sec-Fetch-Site: cross-site`. This is mostly transparent — same-origin requests from the SPA always pass.

Two gotchas to remember:

1. **Internal callers** (auto-tagger webhook, paperless `post_consume`) must send `X-Aktenraum-Secret`. The middleware bypasses CSRF when the header is present (the route handler still verifies the value).

2. **New sensitive GET endpoints**: if you add a `GET` endpoint that streams private user data (similar to `/preview`, `/download`), update `_PROTECTED_GET_SUFFIXES` in `middleware.py` to include the new suffix. Otherwise, a cross-site `<img>` tag could exfiltrate the payload if SameSite=Lax ever weakens.

The existing `/preview` and `/download` endpoints are already covered. Most JSON-returning GETs don't need this protection (CORS already blocks cross-origin reads of credential-bearing JSON responses).

---

## The "get-document-then-patch" idiom

For any route that PATCHes a doc's custom fields, prefer the prefetched-doc shape:

```python
async def apply_field_update(
    gateway: PaperlessGateway,
    doc_id: int,
    update: InboxFieldUpdate,
) -> InboxDetail:
    populated = update.populated()
    if populated:
        # Fetch once; reuse for the merge-read inside the gateway.
        doc = await gateway.get_document(doc_id)
        await gateway.patch_document_custom_fields(
            doc_id, populated, prefetched_doc=doc
        )
    return await get_detail(gateway, doc_id)
```

The gateway's `patch_document_custom_fields` does a merge-read by default (Paperless's PATCH is full-array replace, see the paperless-api-integration skill). Passing `prefetched_doc=doc` skips it. Saves one round trip on every approve / edit.

---

## Response models

Use Pydantic schemas, never raw dicts:

```python
# In schemas.py:
class ExportRequest(BaseModel):
    doc_ids: list[int]
    format: Literal["pdf", "zip"]

class ExportResponse(BaseModel):
    job_id: str
    estimated_seconds: int

# In router.py:
@router.post("/exports/", response_model=ExportResponse)
async def create_export(body: ExportRequest, ...) -> ExportResponse:
    ...
```

`response_model=` does the auto-validation; declared return type drives the OpenAPI schema.

For streaming responses (PDF preview, SSE), use `StreamingResponse` instead — see `documents/router.py:get_preview` and `ai/router.py:answer_stream` for the patterns.

---

## Test fixture pattern

Tests live under `services/aktenraum-api/tests/`. They use `httpx.AsyncClient` against the app + a mocked gateway:

```python
async def test_some_action(client_factory):
    app, _settings, transport = await client_factory(
        BOOTSTRAP_USERNAME="admin",
        BOOTSTRAP_PASSWORD="topsecret",
        PAPERLESS_API_TOKEN="dummy",
    )
    gw = AsyncMock()
    gw.list_tags = AsyncMock(return_value={"ai-pending": 1})
    gw.patch_document_custom_fields = AsyncMock(
        side_effect=lambda doc_id, kv, **_kw: kv  # accept **_kw for new kwargs
    )
    app.dependency_overrides[get_paperless_gateway] = lambda: gw

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/exports/", json={"doc_ids": [1, 2]})

    assert resp.status_code == 200
    gw.patch_document_custom_fields.assert_awaited_once()
```

Notes:

- `client_factory` is the conftest fixture — set up by `services/aktenraum-api/tests/conftest.py`.
- `_login` is a per-file helper that POSTs to `/api/auth/login` so the session cookie is set.
- `**_kw` on AsyncMock side_effects future-proofs them against new optional kwargs (like `prefetched_doc`).
- `app.dependency_overrides[get_paperless_gateway] = lambda: gw` swaps the gateway only for this test.
- The tests run within `app.router.lifespan_context(app)` so startup hooks (bootstrap user, gateway construction) fire.

If a test depends on module-level state (e.g. `documents/router.py:_in_flight_cache`), reset it with an autouse fixture — see `test_status_endpoints.py` for the pattern.

---

## Auth-less internal endpoints

Some endpoints are intentionally not gated by the cookie because the auto-tagger calls them in-network:

- `GET /api/settings/active-llm-model` — reads the active model from the DB. Uses `X-Aktenraum-Secret` when `WEBHOOK_SECRET` is set.
- `PATCH /api/documents/{id}/type-fields` — accepts EITHER the user cookie OR the webhook secret (see `type_fields/router.py:_require_user_or_secret`).

If you add another auto-tagger-callable endpoint, use the `_require_user_or_secret` pattern and ALWAYS use `hmac.compare_digest` for the secret comparison (timing-safe).

---

## OpenAPI types are codegen'd

The SPA generates TS types from the live OpenAPI schema:

```bash
task web:types  # runs `pnpm --filter @aktenraum/web generate:api-types`
```

This means: every Pydantic schema change becomes a SPA-side TypeScript-type change. The Pydantic `Literal["pdf", "zip"]` becomes the equivalent TS union. Aim for clean schemas — they ARE the SPA's API contract.

---

## Adding a new route — minimal checklist

1. ☐ Create `aktenraum_api/<area>/{__init__.py, router.py, service.py, schemas.py}` (or extend existing area).
2. ☐ Router has the area prefix + tags.
3. ☐ Every endpoint declares `_user: User = Depends(get_current_user)`.
4. ☐ Gateway calls wrapped in try/except for the three typed errors.
5. ☐ State-changing endpoints don't need extra CSRF code — middleware handles it.
6. ☐ Sensitive-GET endpoints check `_PROTECTED_GET_SUFFIXES` in `middleware.py`.
7. ☐ `app.include_router(<router>, prefix="/api")` in `main.py`.
8. ☐ Tests under `tests/test_<area>_router.py` mock the gateway and login first.
9. ☐ If schemas changed, regen SPA types: `task web:types`.

---

## Don't

- Don't put business logic in `router.py`. Keep it thin; service module does the work.
- Don't reach into `request.app.state` directly. Use the `Depends` providers.
- Don't return raw dicts. Use Pydantic response models.
- Don't catch `Exception` broadly in route handlers — catch the typed gateway errors and let everything else surface as 500 (FastAPI handles it).
- Don't write a direct `httpx` call to Paperless from a route. Use the gateway.
- Don't add a new sensitive GET without updating `_PROTECTED_GET_SUFFIXES`.
- Don't compare webhook secrets with `==`. Always `hmac.compare_digest`.
