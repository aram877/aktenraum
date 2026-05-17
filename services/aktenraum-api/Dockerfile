FROM python:3.13-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# Workspace manifests first for layer cache.
COPY pyproject.toml uv.lock ./
COPY packages/aktenraum-core/pyproject.toml packages/aktenraum-core/pyproject.toml
COPY services/auto-tagger/pyproject.toml services/auto-tagger/pyproject.toml
COPY services/aktenraum-api/pyproject.toml services/aktenraum-api/pyproject.toml

RUN uv sync --frozen --no-dev --no-install-workspace

# Workspace member sources.
COPY packages/aktenraum-core/src/ packages/aktenraum-core/src/
COPY services/aktenraum-api/src/ services/aktenraum-api/src/
COPY services/aktenraum-api/alembic.ini services/aktenraum-api/alembic.ini
COPY services/aktenraum-api/alembic/ services/aktenraum-api/alembic/
COPY services/aktenraum-api/entrypoint.sh services/aktenraum-api/entrypoint.sh

RUN uv sync --frozen --no-dev

RUN useradd --create-home --shell /bin/bash appuser \
    && chmod +x /app/services/aktenraum-api/entrypoint.sh \
    && chown -R appuser:appuser /app \
    # Pre-create the HuggingFace cache path so the named volume mount in
    # docker-compose.yml inherits appuser ownership. Without this, Docker
    # creates the mount point as root and sentence-transformers fails with
    # PermissionError on the first reranker download.
    && mkdir -p /home/appuser/.cache/huggingface \
    && chown -R appuser:appuser /home/appuser/.cache
USER appuser

ENTRYPOINT ["/app/services/aktenraum-api/entrypoint.sh"]
