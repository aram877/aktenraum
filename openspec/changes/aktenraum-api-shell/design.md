## Context

Phase 0 prepared the workspace; this is where it earns the rent. The custom-frontend roadmap says the SPA is the user's primary interface and `aktenraum-api` is the backend-for-frontend that brokers everything (auth, AI features, eventually a Paperless proxy). For Phase 1 we scope down to the bare minimum that proves the wiring: a logged-in user lands on an empty page. That tightly bounds what we have to get right and avoids re-doing the shell when AI features arrive in Phase 2.

The deployment target stays Docker Compose on a single host. Personal-DMS scale. We optimise for "easy to redeploy" and "easy to extend", not throughput.

## Goals / Non-Goals

**Goals:**
- One command (`docker compose up -d --build`) deploys: paperless, auto-tagger, postgres, redis, gotenberg, tika, backup, **plus** aktenraum-api, nginx-with-SPA. Eight services total.
- Browse to `http://localhost`, log in with bootstrap creds, see "Hello, <username>". Click logout, return to the login form.
- Migrations are part of the deployment: a fresh `pgdata` volume + `docker compose up` results in a working stack with the `aktenraum` database created and the `users` table migrated.
- The SPA never holds the JWT in JS. Auth state is "do I get a 200 from `/api/auth/me`?".
- aktenraum-api's OpenAPI schema is reachable at `/api/openapi.json` and the SPA can later codegen types from it.

**Non-Goals:**
- AI features (Ask, Summarize, QA) — Phase 2.
- Paperless reverse-proxy through aktenraum-api — landed in Phase 2 alongside the first endpoint that needs it.
- HTTPS / Tailscale — separate change later.
- Multi-user auth (registration, roles, password reset) — single user, single password for now.
- CSRF tokens — `SameSite=Lax` cookies + a single-origin nginx setup is enough for personal use.
- Frontend visual polish — Tailwind defaults are fine for the shell.
- Production-grade observability (Prometheus, traces) — structlog JSON to stdout for now.

## Decisions

### D1 — JWT in an httpOnly cookie, not a Bearer header

The SPA never reads or stores the token. `/api/auth/login` sets `aktenraum_session=<jwt>; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`. Subsequent requests carry the cookie automatically. Logout sends `Max-Age=0`. This kills the "XSS-steals-token" attack class and means we never write a token-management hook in the SPA.

Alternative considered: Bearer-in-localStorage with refresh-token rotation. Rejected — more code, more edge cases (tab sync, race-y refresh), no upside for a single-origin personal app.

CSRF: `SameSite=Lax` blocks cross-site POSTs from carrying the cookie. The SPA and API share an origin (both behind nginx), so no cross-site state-changing requests exist by design. Adding double-submit CSRF tokens would be theatre at this scale.

### D2 — Bootstrap user from env on first startup

`BOOTSTRAP_USERNAME` and `BOOTSTRAP_PASSWORD` in `docker/aktenraum-api.env`. On startup, if `users` is empty, the API hashes the password (bcrypt cost 12) and inserts one row. If at least one user exists, env values are ignored. The user can change their password later via a future endpoint (Phase 5 territory; not now).

Alternative considered: a CLI command (`aktenraum-api users add`). Rejected — requires a second image entrypoint and shell-into-container ergonomics. The env approach matches how every other service in this stack bootstraps secrets.

### D3 — `aktenraum` is a separate logical database in the existing Postgres container

One container, two databases (`paperless` and `aktenraum`), same role. The init script `docker/postgres-init/01-create-aktenraum-db.sh` is mounted into Postgres's `/docker-entrypoint-initdb.d/`. Postgres only runs initdb scripts on a fresh data dir, so for **existing installs** the operator must run a one-shot `psql -c "CREATE DATABASE aktenraum OWNER ..."` once. We document this in the change's runbook.

Alternative considered: a separate `aktenraum-postgres` container. Rejected — doubles the operational surface (volumes, backups, healthchecks) for no isolation we actually need at this scale.

### D4 — Migrations run on container start

`services/aktenraum-api/Dockerfile` entrypoint is a small wrapper: `alembic upgrade head && exec uvicorn aktenraum_api.main:app --host 0.0.0.0 --port 8002`. If migrations fail, uvicorn never starts; container goes into restart loop and the operator sees the alembic error in `docker compose logs`.

Alternative considered: a one-shot init container. Rejected — adds compose complexity (an extra service with `restart: no` and a `depends_on: condition: service_completed_successfully`) for a single-container case.

### D5 — One nginx container, multi-stage build, serves SPA + proxies API

The SPA's static build is built inside the nginx image (Node 22 builder stage → copy `dist/` into `nginx:alpine`). The runtime image carries no Node. nginx config:
- `location /` → `try_files $uri /index.html` (SPA fallback for client-side routes)
- `location /api/` → `proxy_pass http://aktenraum-api:8002/api/`

A separate `web` container would mean nginx-proxies-to-nginx-serving-static, which is silly. One container is enough.

The Paperless reverse-proxy lives at the same nginx layer in Phase 2 (`location /paperless/` → `proxy_pass http://paperless:8000/`), but we don't add it now because nothing in Phase 1 calls it.

### D6 — SPA stack: Vite + React 19 + Tailwind v4 + TanStack Router + TanStack Query + Axios

Locked in by `docs/plans/custom-frontend.md`. Concrete picks for Phase 1:
- **TanStack Router** with file-based routing (Vite plugin)
- **TanStack Query** for the `/api/auth/me` fetch and the login mutation
- **Axios** with `withCredentials: true` baked into one shared instance
- **Tailwind v4** uses CSS-first config (no `tailwind.config.js`); imported via `@import "tailwindcss"`
- **shadcn/ui** components added on demand — for Phase 1 we only need a Button and an Input; we hand-write them rather than pulling the full installer until Phase 3
- **TypeScript strict mode** + `noUncheckedIndexedAccess`

### D7 — Test strategy

`services/aktenraum-api/tests/` uses `pytest` + `httpx.AsyncClient` against the FastAPI app, with an in-memory SQLite engine via dependency override for the DB session. Covers:
- `test_health.py` — `/api/health` returns `{"status": "ok"}`
- `test_auth_bootstrap.py` — first-start bootstrap from env creates a user; second start with existing users does nothing
- `test_auth_flow.py` — login success sets cookie, login wrong-password 401s, `/api/auth/me` 401s without cookie and 200s with, logout clears cookie

The SPA does **not** get a unit-test setup in this phase. The shell is too thin to be worth Vitest scaffolding; we add it in Phase 3 when the inbox component lands. The build itself running cleanly in CI is enough verification of the SPA wiring.

### D8 — `JWT_SECRET` is required, no default

If `JWT_SECRET` is empty or unset, the API refuses to start with a clear error message. No silent fallback to a known-weak default. Operator generates one with `openssl rand -base64 32` and adds it to `docker/aktenraum-api.env`. Documented in the env example.

### D9 — Backup picks up the new database automatically

The existing `docker/backup/entrypoint.sh` runs `pg_dumpall` (not `pg_dump <db>`), so the new `aktenraum` database is captured without code changes. We verify with a manual test snapshot during Phase 1 verification and document the verification in the runbook.

If `entrypoint.sh` turns out to dump only `paperless` explicitly, we extend it. Either way the change is small and contained.

## Risks / Trade-offs

- **Existing-install Postgres init scripts don't re-run.** A user with a populated `pgdata/` volume gets the new compose stack but no `aktenraum` database. The API container will fail its first migration. The fix is a one-line `psql` command, but it's a sharp edge. We document it loudly in the runbook and the API's startup error message points to that docs section.
- **Bootstrap creds in env are no worse than other secrets in this repo, but feel scarier.** They're not — paperless's admin password and Anthropic API key are already env-managed. We make the example file clear about file permissions (`chmod 600`).
- **JWT_SECRET rotation invalidates all sessions.** Acceptable: single user, re-login is one form submit. We don't build a key-rotation mechanism for this.
- **Single nginx instance is a SPOF.** Yes, and so is single Postgres, single auto-tagger, single host. Personal scale; we accept it.
- **The `aktenraum-api` reverse-proxy of Paperless is deferred.** That means until Phase 2 ships, the SPA can't read or write Paperless data — but the SPA also doesn't *need* to in Phase 1 (no document views, no search). The shell is honest about its scope.

## Migration / Rollout

For a fresh install:
1. Operator copies `docker/aktenraum-api.env.example` → `docker/aktenraum-api.env`, fills in `JWT_SECRET`, `BOOTSTRAP_USERNAME`, `BOOTSTRAP_PASSWORD`.
2. `docker compose up -d --build`.
3. Browse to `http://localhost`, log in.

For an existing install (already-populated `pgdata`):
1. Same as above, plus one extra step before bringing the new services up:
   ```bash
   docker compose exec postgres psql -U paperless -c "CREATE DATABASE aktenraum OWNER paperless;"
   ```
2. Then `docker compose up -d --build`.

The runbook update in this change covers both paths explicitly. Verification:
- `docker compose ps` shows all eight services healthy/up
- `curl -s http://localhost/api/health` returns `{"status":"ok"}`
- Browser `http://localhost/login` form submits successfully and redirects
- `docker compose exec postgres psql -U paperless -d aktenraum -c "select count(*) from users;"` returns 1
