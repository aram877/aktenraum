# ADR-003: CSRF Defence — `Sec-Fetch-Site` Middleware

**Status**: Accepted

## Context

The aktenraum-api authenticates browsers with an httpOnly cookie marked `SameSite=Lax`. Lax cookies are not sent on cross-site **subrequests** (`<img>`, `<form>` POST from a third-party page, `fetch` from `attacker.com`), so the most obvious CSRF vectors are already blocked. But the bar for a product shipping to non-technical buyers is "doesn't leak secrets even if a future browser bug, Tailscale-sibling domain, or `SameSite=None` flip widens the threat surface."

A multi-agent security review surfaced two concrete residual risks in the default configuration:

1. **CSRF on state-changing POSTs.** Lax does block cross-site form POSTs from sending the cookie *today*, but every state-changing route (`/api/inbox/{id}/approve`, `/api/documents/{id}/reprocess`, `/api/documents/upload`, etc.) has no second-line check. A future cookie-policy regression (Safari has shipped Lax-to-None drift before) or a same-site sibling subdomain (`a.tailscale.net` vs `b.tailscale.net`) would re-open the attack.

2. **GET-data exfiltration on `/preview` and `/download`.** Same logic — Lax blocks the cookie on cross-site `<img>` loads today, but the endpoints stream PDF binaries with no second-line check.

Neither is exploitable in the default install. Both are cheap to close.

## Decision

We will add a Starlette middleware (`aktenraum_api.middleware.CSRFMiddleware`) that runs before every request and rejects browser-originated calls whose `Sec-Fetch-Site` header indicates a cross-site origin. Specifically:

- Every state-changing method (`POST`, `PUT`, `PATCH`, `DELETE`) is checked.
- Every `GET` whose path ends in `/preview` or `/download` is checked.
- The check passes when `Sec-Fetch-Site` is `same-origin`, `same-site`, `none`, or missing (non-browser clients like curl never send the header, and they aren't subject to the CSRF threat model — they need real credentials anyway).
- Requests carrying `X-Aktenraum-Secret` bypass the check (internal callers — auto-tagger webhook, paperless `post_consume` hook). The secret value is verified by the route handlers themselves; here we only use the *presence* of the header as a "this is a server-to-server call" signal, which an attacker page cannot set on a cross-site fetch without a CORS preflight (and we never reply to such preflights).

A companion `SecurityHeadersMiddleware` sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer` on every response so the JSON endpoints don't rely on the SPA-tier nginx headers alone.

The strict CSP for HTML responses stays in nginx (`docker/nginx/nginx.conf`) — it's the right layer for static-asset delivery, and the API never serves HTML.

## Consequences

### What this enables

- Defence-in-depth on top of `SameSite=Lax`. A future cookie-policy regression no longer trips a CSRF gap.
- The `/preview` and `/download` endpoints are protected against cross-site `<img>` exfiltration even on browsers where Lax is treated permissively on subresource loads.
- A clean public surface area: anything carrying `Sec-Fetch-Site: cross-site` is rejected, full stop.

### What this constrains

- The SPA must be served from the **same origin** as the API. The compose nginx already enforces this (it proxies `/api/*` to aktenraum-api and serves the SPA from `/`), so no change is needed today. If we ever split the SPA onto a separate origin (e.g. CDN), we'll have to add a CORS allowlist + a custom-header CSRF token instead.
- The Tauri desktop shell will run the SPA inside a WebView whose origin depends on the platform (`tauri://localhost` on macOS, `https://tauri.localhost` on Windows, etc.). The compose stack still backs the API at `http://localhost:8080`, so requests from the WebView land as `Sec-Fetch-Site: cross-site`. **The Tauri shell must inject `X-Aktenraum-Secret` into its outbound API requests OR set a same-origin proxy** — see desktop-app phase 0.4 in `docs/plans/desktop-app.md`.
- Non-browser clients (CI scripts, future CLI) keep working unchanged because they don't send `Sec-Fetch-Site`.

### What this rules out

- We won't add a double-submit CSRF token. `Sec-Fetch-Site` is sent by every browser we target (Chrome 76+, Firefox 90+, Safari 16+), is impossible for attacker JS to forge (the browser owns the header), and keeps the SPA free of token-juggling code.
- We won't gate on `Origin` header alone. Origin matching breaks when the same product is served on multiple ports during dev (5173 hot reload vs 8080 nginx), and Lax already provides the cookie-level Origin check.
