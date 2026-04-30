#!/usr/bin/env bash
# Run migrations before starting uvicorn. If alembic fails, uvicorn never
# starts; the container restart loop surfaces the error in `docker compose logs`.
set -euo pipefail

cd /app/services/aktenraum-api
/app/.venv/bin/alembic upgrade head

exec /app/.venv/bin/aktenraum-api
