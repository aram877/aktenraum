## Why

Security items left from the 2026-10-01 review (Qdrant without auth, root containers, API weaknesses) — and, found while fixing them, the backup had never produced a usable snapshot on the dev Mac.

## What Changes

- Qdrant requires `QDRANT_API_KEY` (compose `:?`), all clients send it; `bootstrap-secrets.sh` generates it.
- nginx → `nginx-unprivileged` (port 8080 in-container), Qdrant → `-unprivileged`; `cap_drop: ALL` + `no-new-privileges` on built services, Qdrant and nginx; backup gets `no-new-privileges`.
- Sessions carry a password fingerprint; password change invalidates every other session.
- Login: per-username throttle (10 / 15 min → 429), constant-time unknown-user path.
- `WEBHOOK_SECRET` fails closed everywhere; the CSRF bypass checks the secret's value, not its presence; type-fields cookie path uses the full session check.
- Uploads stream to temp files on disk; previews/downloads of non-PDF/image content are forced to attachment with `CSP: sandbox`.
- Backup: DB dumps first, files via `tar` → `restic backup --stdin-from-command` (restic's own reads fail with EIO on Docker Desktop mounts); restic 0.18 / alpine 3.22; freshness healthcheck over all three tags; `verify-backup.sh` asserts originals come back.
- `bootstrap-secrets.sh` carries secrets over from the old per-service env files and refuses to invent a restic password for an existing repository.

## Capabilities

### New Capabilities
- `security-hardening`

### Modified Capabilities

## Impact

All services; one forced re-login; `QDRANT_API_KEY` must exist in `docker/.env` on every host; native-Linux hosts must `chown 1000:1000` the Qdrant data dir.
