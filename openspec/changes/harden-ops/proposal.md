## Why

Step 5 of the 2026-10-01 review: the SPA was served without any security headers (nginx drops inherited `add_header`s in a location that declares its own), CI built no images and installed with a non-frozen lockfile, most services had no healthcheck, Paperless/Tika had no memory cap, several images floated on tags, and the Qdrant client (1.19) ran against a 1.17 server.

## What Changes

- Security headers moved to `docker/nginx/security-headers.conf`, included at server level and in `location = /index.html`.
- Healthchecks for redis, aktenraum-api, auto-tagger and nginx; paperless waits for healthy redis, nginx for a healthy api; worker `stop_grace_period: 30s`.
- `mem_limit` for paperless (`PAPERLESS_MEM_LIMIT`, 4g) and tika (`TIKA_MEM_LIMIT`, 2g).
- Digest pins for postgres, redis, qdrant (running digests) and all Dockerfile bases; `--frozen-lockfile` everywhere.
- `@qdrant/js-client-rest` pinned `~1.17.0`.
- CI `images` job: compose config validation, build all images, `nginx -t`.
- Worker startup index reconcile retries (30 s × 10) instead of failing once when Paperless is still booting.
- `DATABASE_URL` drops the Python-era `+asyncpg` scheme.

## Capabilities

### New Capabilities
- `ops-hardening`: edge headers, container health/limits, reproducible builds, CI image checks.

### Modified Capabilities

## Impact

`docker/{docker-compose.yml,nginx/*,backup/Dockerfile}`, `services/*/Dockerfile`, `.github/workflows/ci.yml`, `packages/aktenraum-core/package.json`, `pnpm-lock.yaml`, `services/auto-tagger/src/{loops,main}.ts`. Applying the compose change recreates every container once.
