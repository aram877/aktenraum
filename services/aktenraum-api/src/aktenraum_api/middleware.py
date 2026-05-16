"""HTTP middleware: CSRF defence + security headers.

CSRF strategy: every state-changing request (POST/PATCH/PUT/DELETE) and
every sensitive cross-readable GET (`/preview`, `/download`) must come from
the SPA running on the same origin, OR from an internal caller bearing
the shared webhook secret. We check `Sec-Fetch-Site` first because all
modern browsers send it; if the header is absent we accept the request
(non-browser clients like curl never have it, and they aren't subject to
the CSRF threat model — they need real credentials anyway).

This is defence-in-depth on top of `SameSite=Lax` on the auth cookie:
Lax already blocks most cross-site POSTs from sending the cookie, but
older browsers and same-site sibling subdomains (Tailscale) widen the
threat surface. Sec-Fetch-Site closes those edges.
"""

from __future__ import annotations

import structlog
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

log = structlog.get_logger()

_STATE_CHANGING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

# Browsers send these on every request. We accept anything that isn't
# explicitly cross-site. `none` is sent for top-level navigations (direct
# bookmark, refresh) and is fine: it's not driven by another page.
_SAFE_SITE_VALUES = frozenset({"same-origin", "same-site", "none"})

# GETs that return raw user data (PDF binaries) get the same site check —
# even though SameSite=Lax already blocks the cookie on cross-site
# subresource loads, defence-in-depth is cheap here.
_PROTECTED_GET_SUFFIXES = ("/preview", "/download")

# Paths that bypass the CSRF check entirely.
_CSRF_EXEMPT_PATHS = frozenset(
    {
        "/api/health",
        "/api/openapi.json",
        "/api/docs",
    }
)


class CSRFMiddleware(BaseHTTPMiddleware):
    """Block cross-site state-changing requests.

    Allows requests where:
    - `Sec-Fetch-Site` is one of `same-origin`, `same-site`, `none`, or
      absent (non-browser client).
    - `X-Aktenraum-Secret` header is present (internal caller — the
      auto-tagger and paperless's post_consume hook). The secret is
      verified by the individual route handlers, not here.

    Rejects with 403 otherwise.
    """

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next):  # type: ignore[override]
        if not self._needs_check(request):
            return await call_next(request)
        if self._is_internal_caller(request):
            return await call_next(request)
        site = request.headers.get("sec-fetch-site")
        if site is None or site in _SAFE_SITE_VALUES:
            return await call_next(request)
        log.warning(
            "csrf_blocked",
            path=request.url.path,
            method=request.method,
            sec_fetch_site=site,
        )
        return JSONResponse(
            status_code=403,
            content={"detail": "Cross-site request blocked"},
        )

    @staticmethod
    def _needs_check(request: Request) -> bool:
        path = request.url.path
        if path in _CSRF_EXEMPT_PATHS:
            return False
        if request.method in _STATE_CHANGING_METHODS:
            return True
        if request.method == "GET" and path.endswith(_PROTECTED_GET_SUFFIXES):
            return True
        return False

    @staticmethod
    def _is_internal_caller(request: Request) -> bool:
        # The secret value itself is verified by the routes that accept it;
        # here we only need to know "this is a server-to-server call, not
        # a browser request". An attacker page cannot set this header on a
        # cross-site fetch without a CORS preflight, and we don't reply with
        # `Access-Control-Allow-Headers` for it.
        return "x-aktenraum-secret" in request.headers


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Defensive HTTP response headers.

    The SPA is served by nginx, not this service, so the strict CSP lives
    in nginx (see `docker/nginx/nginx.conf`). The API only ever returns
    JSON or streamed binaries, so we add a minimal set:

    - `X-Content-Type-Options: nosniff` — block MIME sniffing on JSON.
    - `X-Frame-Options: DENY` — JSON endpoints never belong in an iframe.
    - `Referrer-Policy: no-referrer` — don't leak doc ids via the Referer
      header on outbound clicks from a PDF.
    """

    async def dispatch(self, request: Request, call_next):  # type: ignore[override]
        response: Response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        return response
