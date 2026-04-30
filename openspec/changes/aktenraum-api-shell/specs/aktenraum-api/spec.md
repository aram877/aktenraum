## ADDED Requirements

### Requirement: aktenraum-api is a FastAPI service that exposes /api/health

The repository SHALL contain a Python service `aktenraum-api` at `services/aktenraum-api/`, registered as a uv workspace member, depending on `aktenraum-core`. It SHALL expose a `GET /api/health` endpoint returning `{"status": "ok"}` with HTTP 200, no auth required.

#### Scenario: Health endpoint returns ok

- **WHEN** an HTTP GET is made to `/api/health` against a running aktenraum-api
- **THEN** the response is HTTP 200 with body `{"status": "ok"}`

### Requirement: aktenraum-api authenticates users via JWT-in-httpOnly-cookie

The service SHALL provide three auth endpoints:

- `POST /api/auth/login` accepting `{"username": str, "password": str}`. On success, sets a `Set-Cookie` header carrying a JWT signed with `JWT_SECRET` (HS256), with attributes `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=JWT_EXPIRES_SECONDS`, and `Secure` when `COOKIE_SECURE=true`. Response body is `{"username": str}`. Returns HTTP 401 on wrong credentials.
- `GET /api/auth/me` reads the cookie. If valid, returns `{"username": str}` with HTTP 200. Otherwise 401.
- `POST /api/auth/logout` clears the cookie via `Max-Age=0`. Returns HTTP 204.

The SPA SHALL never receive the JWT in a response body or read it from JavaScript.

#### Scenario: Successful login sets the auth cookie

- **WHEN** `POST /api/auth/login` is called with valid credentials
- **THEN** the response is HTTP 200, the body is `{"username": ...}`, and a `Set-Cookie` header sets the configured cookie name with `HttpOnly`, `SameSite=Lax`, and a JWT value

#### Scenario: Failed login returns 401 without cookie

- **WHEN** `POST /api/auth/login` is called with an unknown username or wrong password
- **THEN** the response is HTTP 401 and no `Set-Cookie` header is sent

#### Scenario: /api/auth/me requires a valid cookie

- **WHEN** `GET /api/auth/me` is called without the auth cookie
- **THEN** the response is HTTP 401
- **WHEN** the same request includes the cookie set by a successful login
- **THEN** the response is HTTP 200 with `{"username": ...}`

#### Scenario: Logout clears the cookie

- **WHEN** `POST /api/auth/logout` is called
- **THEN** the response is HTTP 204 with a `Set-Cookie` header that clears the auth cookie (Max-Age=0)

### Requirement: aktenraum-api bootstraps a single user from environment on first startup

If the `users` table is empty at service startup AND both `BOOTSTRAP_USERNAME` and `BOOTSTRAP_PASSWORD` env vars are set, the service SHALL insert one user with the bcrypt hash of the password. If the table already contains at least one user, the service SHALL ignore the bootstrap env vars.

#### Scenario: First startup with empty DB seeds the bootstrap user

- **WHEN** aktenraum-api starts against a fresh `aktenraum` database with `BOOTSTRAP_USERNAME=admin` and `BOOTSTRAP_PASSWORD=test1234`
- **THEN** after lifespan completes, exactly one row exists in `users` with `username='admin'` and a bcrypt hash of `test1234`

#### Scenario: Second startup is idempotent

- **WHEN** aktenraum-api starts against a database that already contains a user
- **THEN** no new user is created and the existing user's password is unchanged, regardless of the env values

### Requirement: aktenraum-api refuses to start without JWT_SECRET

If `JWT_SECRET` is unset or empty at startup, the service SHALL log an error explaining the requirement and exit with non-zero status, rather than fall back to a known-weak default.

#### Scenario: Missing JWT_SECRET aborts startup

- **WHEN** the service starts with `JWT_SECRET=""`
- **THEN** it logs a clear error and exits with non-zero status without binding the HTTP port

### Requirement: aktenraum-api exposes its OpenAPI schema at /api/openapi.json

The auto-generated FastAPI OpenAPI document SHALL be reachable at `/api/openapi.json` and the interactive docs at `/api/docs` (or behind a `--docs` env-toggle). The schema is the contract the SPA codegens types from.

#### Scenario: OpenAPI is reachable

- **WHEN** an HTTP GET is made to `/api/openapi.json`
- **THEN** the response is HTTP 200 with a valid OpenAPI 3.x JSON document listing the auth and health endpoints

### Requirement: aktenraum-api runs Alembic migrations on container start

The container's entrypoint SHALL run `alembic upgrade head` before starting uvicorn. If migrations fail, uvicorn SHALL NOT start and the container exits non-zero.

#### Scenario: Fresh database is migrated on first boot

- **WHEN** the container starts against an empty `aktenraum` database
- **THEN** the `users` table exists after lifespan with the schema defined by Alembic revision 0001
