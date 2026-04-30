FROM python:3.13-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# Copy workspace manifests first so the dependency layer caches across source changes.
COPY pyproject.toml uv.lock ./
COPY packages/aktenraum-core/pyproject.toml packages/aktenraum-core/pyproject.toml
COPY services/auto-tagger/pyproject.toml services/auto-tagger/pyproject.toml

# Install dependencies (workspace members not yet copied; uv installs deps only).
RUN uv sync --frozen --no-dev --no-install-workspace

# Copy workspace member sources.
COPY packages/aktenraum-core/src/ packages/aktenraum-core/src/
COPY services/auto-tagger/src/ services/auto-tagger/src/

# Install the workspace itself.
RUN uv sync --frozen --no-dev

# Non-root user — chown before switching so the venv is accessible.
RUN useradd --create-home --shell /bin/bash appuser && chown -R appuser:appuser /app
USER appuser

ENTRYPOINT ["/app/.venv/bin/auto-tagger"]
