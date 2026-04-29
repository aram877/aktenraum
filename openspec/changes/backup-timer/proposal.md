## Why

The backup script (`scripts/backup.sh`) is authored and tested but never runs automatically. Without a scheduler, backups only happen when the operator remembers to run the script manually — which is not a backup strategy. The systemd timer already authored targets Linux hosts; the current runtime is Docker Desktop on Windows, where systemd is unavailable. A Docker-native scheduler removes the host-OS dependency and works identically on Windows and Linux.

## What Changes

- **New `backup` Docker service** added to `docker/docker-compose.yml`: Alpine-based container with `restic` and `postgresql-client`, running `crond` as its main process. Fires the backup script daily at 02:00.
- **New `docker/backup/` directory** containing: `Dockerfile`, `entrypoint.sh` (backup logic adapted for in-container execution — direct postgres connection via network hostname, container-local volume paths), `crontab`.
- **New `docker/backup.env.example`** documenting restic credentials (`RESTIC_PASSWORD`) and optional B2 vars.
- **`scripts/backup.sh` kept as-is** for manual host-side runs; the container has its own `entrypoint.sh` that mirrors the logic with Docker-appropriate paths.
- **Operations runbook updated** with how to check backup logs from the container and how to trigger a manual backup run.

## Capabilities

### New Capabilities

- `backup-service`: Containerised daily backup with restic — covers Paperless data dirs and a live postgres dump, applies retention policy, optionally syncs to B2.

### Modified Capabilities

*(none)*

## Impact

- One new Docker service added to the compose stack (`backup`). On first `docker compose up -d`, it will build and start.
- Requires `docker/backup.env` (gitignored) to be created from example before the service will run successfully.
- No changes to existing services or data layout.
- The existing systemd units in `docker/systemd/` remain for future Linux-native deployments; they are not removed.
