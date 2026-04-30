## ADDED Requirements

### Requirement: nginx edge container serves the SPA and proxies /api/* to aktenraum-api

The `docker/nginx/` directory SHALL contain a multi-stage Dockerfile that builds the SPA in a Node 22 stage and copies the resulting `dist/` into an `nginx:alpine` runtime stage. The runtime container SHALL listen on port 80, serve SPA static assets at `/` (with `try_files $uri /index.html` for client-side routing), and reverse-proxy `/api/*` to `aktenraum-api:8002`.

The compose file SHALL publish nginx on `127.0.0.1:80` (not `0.0.0.0`) so the personal stack is local-host only by default.

#### Scenario: SPA loads at the root path

- **WHEN** an HTTP GET is made to `http://localhost/`
- **THEN** the response is HTTP 200 with the SPA's `index.html`

#### Scenario: Unknown SPA route falls back to index.html

- **WHEN** an HTTP GET is made to `http://localhost/some/spa/route` and there is no static file at that path
- **THEN** the response is HTTP 200 with `index.html` so the SPA router can pick up the route

#### Scenario: API requests are proxied

- **WHEN** an HTTP GET is made to `http://localhost/api/health`
- **THEN** nginx proxies the request to `aktenraum-api:8002/api/health` and returns the upstream response unchanged
