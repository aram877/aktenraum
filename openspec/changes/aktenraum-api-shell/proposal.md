## Why

Phase 0 extracted `aktenraum-core` so a second Python service can reuse the LLM/Paperless code; this change is that second service's first slice. It scaffolds the **HTTP API** (`aktenraum-api`) the SPA will talk to, the **SPA itself** (`apps/web`) that will eventually replace Paperless's web UI, and the **nginx edge container** that ties them together so a developer can run `docker compose up -d --build` and immediately log in to a working — but empty — dashboard at `http://localhost`.

It deliberately does not ship any AI features, document views, search, or upload yet. Those come in Phase 2 onwards. Shipping the empty shell first means every subsequent phase only adds features into a tested, deployable, fully-wired stack — no shell-rewrite churn later.

## What Changes

- **New `aktenraum-api` Python service** at `services/aktenraum-api/`: FastAPI 0.118+, SQLAlchemy 2 async + asyncpg, Alembic, structlog, pydantic-settings. Exposes `/api/health`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`, plus the auto-generated `/openapi.json`. Joins the uv workspace and depends on `aktenraum-core`.
- **JWT-in-httpOnly-cookie authentication**: bcrypt password hashing via passlib; tokens are HS256 JWTs signed with `JWT_SECRET`, default 8-hour expiry. The cookie is `httpOnly`, `SameSite=Lax`, `Secure` when behind HTTPS (off for plain-HTTP localhost). The SPA never sees the raw token.
- **Bootstrap user from env**: on first startup, if no user exists, create one from `BOOTSTRAP_USERNAME` and `BOOTSTRAP_PASSWORD`. Idempotent — once a user exists, env values are ignored. Single-user model for now; multi-user is a future change.
- **New `aktenraum` logical database** in the existing Postgres container, owned by the existing Paperless user. Created via a new `docker/postgres-init/01-create-aktenraum-db.sh` mounted into `/docker-entrypoint-initdb.d/`. The existing `pg_dump` in the backup container picks it up automatically (uses `pg_dumpall`, or we add the second DB explicitly).
- **Alembic migrations** managed under `services/aktenraum-api/alembic/`. The container entrypoint runs `alembic upgrade head` before starting `uvicorn`, so migrations are part of `docker compose up`.
- **New `apps/web/` Vite + React + TypeScript SPA** replacing the existing placeholder. Stack: React 19, Tailwind v4, TanStack Router, TanStack Query, Axios with `withCredentials` for the auth cookie. Two routes: `/login` (form) and `/` (empty authenticated dashboard showing the logged-in username). An auth guard redirects unauthenticated users to `/login`. The Angular cache directory in `apps/web/.angular/` is removed.
- **New `nginx` edge container** at `docker/nginx/`: multi-stage Dockerfile (Node 22 builder runs `pnpm build` against `apps/web/` → static files copied into `nginx:alpine`). The runtime nginx serves SPA assets at `/`, proxies `/api/*` to `aktenraum-api:8002`, and falls back to `index.html` for client-side routes. Publishes `127.0.0.1:80` to the host.
- **`docker-compose.yml` gains three services**: `aktenraum-api`, `nginx`, and a Postgres init-script volume. The compose stack is the new deployment unit — start it once and the whole product is up.
- **CI updated** to also lint+test `aktenraum-api` via the existing workspace-root commands (no extra job needed) and to run the SPA's `pnpm install`, lint, and build.

## Capabilities

### New Capabilities

- `aktenraum-api`: HTTP API for the SPA. Owns request/response handling, auth, persistence, and (in later phases) AI features. Stateless Python service backed by Postgres for users + future state.
- `aktenraum-web`: Single-page React application that calls only `aktenraum-api`. The user's primary interface; replaces direct use of Paperless's web UI for the day-to-day flow.
- `aktenraum-edge`: nginx container that publishes a single host-facing port, serves the SPA, and reverse-proxies `/api/*` to `aktenraum-api`. Future home of TLS termination.

### Modified Capabilities

- `repo-structure`: pnpm workspace `apps/web` is now a real React project, not a placeholder.
- `paperless-deployment`: the Postgres container now hosts a second logical database (`aktenraum`) created at first init by a new init script.
- `backup-system`: backup must capture the new `aktenraum` database alongside `paperless`. Verify in this change; extend `entrypoint.sh` if needed.

## Impact

- **One new host-facing port (80)** published by the `nginx` container on `127.0.0.1`. Paperless's `127.0.0.1:8000` remains exposed for backend admin tasks; the goal is for day-to-day use to live on `:80`.
- **Two new env files**: `docker/aktenraum-api.env.example` (committed) and `docker/aktenraum-api.env` (gitignored). They carry `JWT_SECRET`, `BOOTSTRAP_USERNAME`, `BOOTSTRAP_PASSWORD`, and `DATABASE_URL` (defaults to the in-cluster Postgres).
- **Postgres data volume incompatibility on existing installs**: the init script only runs on a fresh `pgdata` volume. For existing installs the operator must manually `CREATE DATABASE aktenraum OWNER paperless;` once. Documented in the change's design and in `docs/runbooks/operations.md`.
- **Frontend toolchain on the host**: the developer needs Node 22 + pnpm to iterate on the SPA outside Docker (matches the existing `.nvmrc`). For deploy, only Docker is needed.
- **No behaviour change for auto-tagger** — the existing extraction pipeline is untouched.
