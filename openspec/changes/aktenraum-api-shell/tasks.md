## 1. aktenraum-api Service Scaffold

- [ ] 1.1 Create `services/aktenraum-api/pyproject.toml` (deps: fastapi, uvicorn[standard], sqlalchemy[asyncio], asyncpg, alembic, passlib[bcrypt], pyjwt, pydantic-settings, structlog, aktenraum-core).
- [ ] 1.2 Register `services/aktenraum-api` as a uv workspace member in the root `pyproject.toml`.
- [ ] 1.3 Create `src/aktenraum_api/__init__.py`, `config.py` (Pydantic Settings — DATABASE_URL, JWT_SECRET, JWT_EXPIRES_SECONDS, BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD, COOKIE_NAME, COOKIE_SECURE, LOG_LEVEL), `main.py` (FastAPI app factory + lifespan that runs bootstrap), `health.py` (`/api/health` returns `{"status": "ok"}`).

## 2. Persistence

- [ ] 2.1 `src/aktenraum_api/db/__init__.py`, `db/session.py` (async engine + `AsyncSessionLocal`), `db/models.py` (`User` table: id PK, username unique, password_hash, created_at).
- [ ] 2.2 Initialise Alembic at `services/aktenraum-api/alembic/` (configure `alembic.ini` to read from `DATABASE_URL`; `env.py` reads settings).
- [ ] 2.3 Generate the initial revision creating `users`. Commit the revision file.
- [ ] 2.4 `src/aktenraum_api/entrypoint.sh` runs `alembic upgrade head` then `exec uvicorn aktenraum_api.main:app --host 0.0.0.0 --port 8002`.

## 3. Auth

- [ ] 3.1 `src/aktenraum_api/auth/jwt.py` — `create_token(user_id) -> str`, `verify_token(token) -> int | None` (HS256, JWT_SECRET, JWT_EXPIRES_SECONDS).
- [ ] 3.2 `src/aktenraum_api/auth/passwords.py` — bcrypt hash + verify via passlib.
- [ ] 3.3 `src/aktenraum_api/auth/router.py` — `POST /api/auth/login` (sets cookie), `POST /api/auth/logout` (clears cookie), `GET /api/auth/me` (requires cookie).
- [ ] 3.4 `src/aktenraum_api/auth/deps.py` — `get_current_user` FastAPI dependency reads the cookie, validates the JWT, returns the User row or raises 401.
- [ ] 3.5 `src/aktenraum_api/auth/bootstrap.py` — async function called from app lifespan: if `users` empty and `BOOTSTRAP_USERNAME` + `BOOTSTRAP_PASSWORD` set, insert one user.

## 4. Tests

- [ ] 4.1 `tests/conftest.py` — `pytest` + `pytest-asyncio` + `httpx.AsyncClient` against the FastAPI app, with the DB dependency overridden to an in-memory aiosqlite engine. Provide a `client` fixture and a `make_user` fixture.
- [ ] 4.2 `tests/test_health.py` — health returns `{"status": "ok"}`.
- [ ] 4.3 `tests/test_auth_bootstrap.py` — empty DB + env creds creates one user; second startup with users present no-ops; missing env creds with empty DB no-ops.
- [ ] 4.4 `tests/test_auth_flow.py` — login success sets the cookie and returns the user; wrong password returns 401; `/api/auth/me` is 401 without cookie and 200 with; logout clears the cookie.
- [ ] 4.5 Verify `uv run pytest` from workspace root collects + passes the new tests alongside auto-tagger's existing 108.

## 5. Container

- [ ] 5.1 `services/aktenraum-api/Dockerfile` — same multi-stage shape as auto-tagger (Python 3.13 slim + uv, build context = repo root).
- [ ] 5.2 `services/aktenraum-api/aktenraum-api.env.example` documenting `JWT_SECRET`, `JWT_EXPIRES_SECONDS`, `BOOTSTRAP_USERNAME`, `BOOTSTRAP_PASSWORD`, `DATABASE_URL`, `LOG_LEVEL`. Move into `docker/aktenraum-api.env.example` if it lives there per existing convention.

## 6. Postgres Aktenraum Database

- [ ] 6.1 `docker/postgres-init/01-create-aktenraum-db.sh` — bash script that runs `psql -c "CREATE DATABASE aktenraum OWNER ${POSTGRES_USER};"` (idempotent: check first via `SELECT 1 FROM pg_database WHERE datname='aktenraum';`).
- [ ] 6.2 Mount `./postgres-init` into postgres at `/docker-entrypoint-initdb.d/` in `docker-compose.yml`.

## 7. SPA — apps/web

- [ ] 7.1 Remove `apps/web/.angular/` and any other Angular leftovers; keep the directory itself.
- [ ] 7.2 `apps/web/package.json` (`@aktenraum/web`, private, scripts: `dev`, `build`, `lint`, `preview`, `generate:api-types`). Deps: react@19, react-dom@19, @tanstack/react-router, @tanstack/react-query, axios. DevDeps: vite, typescript, @vitejs/plugin-react, tailwindcss@4, @tanstack/router-plugin, eslint + tseslint, openapi-typescript.
- [ ] 7.3 `apps/web/vite.config.ts` (port 5173 on dev; proxy `/api` to `http://localhost:80` so dev iteration works against the running compose stack).
- [ ] 7.4 `apps/web/tsconfig.json` + `tsconfig.node.json` (strict, `noUncheckedIndexedAccess`, target ES2022).
- [ ] 7.5 `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/routes/__root.tsx`, `routes/index.tsx`, `routes/login.tsx`. Use TanStack Router file-based routing.
- [ ] 7.6 `apps/web/src/lib/api.ts` — single axios instance with `baseURL: "/api"`, `withCredentials: true`. Helpers `login(username, password)`, `logout()`, `me()`.
- [ ] 7.7 `apps/web/src/features/auth/Login.tsx` — form with username + password, calls `login()`, on success navigates `/`. On error shows message.
- [ ] 7.8 `apps/web/src/features/auth/AuthGuard.tsx` — wraps the index route; uses `useQuery(["me"], me)` and redirects to `/login` on 401.
- [ ] 7.9 `apps/web/src/components/layout/AppShell.tsx` — header with username + logout, empty content area placeholder.
- [ ] 7.10 `apps/web/src/index.css` — `@import "tailwindcss"` and a small base style block.
- [ ] 7.11 `apps/web/.eslintrc.cjs` or `eslint.config.js` (flat config preferred), `apps/web/.gitignore` (covers `dist/`, `node_modules/`).

## 8. Edge nginx Container

- [ ] 8.1 `docker/nginx/Dockerfile` — multi-stage: stage 1 (`node:22-alpine` + pnpm, runs `pnpm install --frozen-lockfile && pnpm --filter @aktenraum/web build`); stage 2 (`nginx:alpine` copies `dist/` to `/usr/share/nginx/html`).
- [ ] 8.2 `docker/nginx/nginx.conf` — `server { listen 80; root /usr/share/nginx/html; location /api/ { proxy_pass http://aktenraum-api:8002/api/; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; } location / { try_files $uri $uri/ /index.html; } }`.

## 9. Compose Wiring

- [ ] 9.1 Add `aktenraum-api` service: build context `..`, dockerfile `services/aktenraum-api/Dockerfile`, depends_on postgres healthy, env_file `aktenraum-api.env`, expose 8002, on internal network.
- [ ] 9.2 Add `nginx` service: build context `..`, dockerfile `docker/nginx/Dockerfile`, depends_on aktenraum-api, ports `127.0.0.1:80:80`, internal network.
- [ ] 9.3 Mount `./postgres-init:/docker-entrypoint-initdb.d:ro` on the postgres service.

## 10. CI

- [ ] 10.1 Confirm `uv run ruff check` and `uv run pytest` from workspace root pick up `aktenraum-api` automatically (they should — workspace member). Add `aktenraum-api`'s `tests/` to root `pyproject.toml` `testpaths`.
- [ ] 10.2 Add a `web` job to `.github/workflows/ci.yml`: install pnpm, `pnpm install --frozen-lockfile`, `pnpm --filter @aktenraum/web build`, `pnpm --filter @aktenraum/web lint`. Cache pnpm store on lockfile.

## 11. End-to-End Verification

- [ ] 11.1 `docker compose up -d --build` from `docker/`. All eight services reach running/healthy.
- [ ] 11.2 `curl -s http://localhost/api/health` → `{"status":"ok"}`.
- [ ] 11.3 Browser to `http://localhost/login`, submit bootstrap credentials, expect redirect to `/` and the username displayed.
- [ ] 11.4 `docker compose exec postgres psql -U paperless -d aktenraum -c "select username from users;"` shows one row.
- [ ] 11.5 Verify the backup container's next snapshot includes the `aktenraum` database (manual run via `docker compose exec backup /usr/local/bin/entrypoint.sh`; inspect snapshot contents).

## 12. Documentation

- [ ] 12.1 Update `docs/plans/custom-frontend.md`: Phase 1 → done with archive link; Phase 2 → in progress.
- [ ] 12.2 Update `CLAUDE.md`: stack table now lists 8 services; add a frontend dev workflow section (pnpm, vite dev, generate:api-types); add a brief note for existing-install operators about creating the `aktenraum` database manually.
- [ ] 12.3 Update `docs/runbooks/operations.md` with the existing-install upgrade path (`CREATE DATABASE aktenraum`) and the new login-and-troubleshooting steps.
