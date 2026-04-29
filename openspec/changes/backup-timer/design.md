## Context

The stack runs entirely in Docker (Docker Desktop on Windows, or Docker Engine on Linux). The host OS cannot be assumed to have systemd. The backup container joins the existing internal Docker network, giving it direct TCP access to the `postgres` service — eliminating the need to shell into another container via `docker exec`.

## Goals / Non-Goals

**Goals:**
- Backup runs daily at 02:00 without any operator action after initial setup
- Postgres dump is piped directly into restic (no plaintext file on disk)
- Container is stateless: restic repo and data dirs are mounted volumes
- Works on Windows Docker Desktop and Linux Docker Engine without changes

**Non-Goals:**
- Replacing `scripts/backup.sh` for manual host-side runs
- Removing the systemd units (kept for Linux-native future use)
- Email/alerting on backup failure (logged to stdout, visible via `docker compose logs backup`)

## Decisions

### D1 — Alpine + restic + postgresql-client (no custom base image)

Alpine gives a minimal image (~10 MB). `restic` and `postgresql-client` are both in the Alpine package index. No custom base image needed. Build time is fast; the image is small.

### D2 — crond as PID 1 (not a wrapper script with sleep loop)

Alpine's `crond` (busybox) accepts a crontab file and logs to stdout when run with `-f -l 2`. This is the standard pattern for scheduled tasks in Alpine containers. A sleep loop would be simpler but wouldn't respect system time properly and would be harder to observe.

### D3 — Direct postgres connection (not docker exec)

The backup container is on the `internal` Docker network and can reach postgres at hostname `postgres`. `pg_dump -h postgres -U $PAPERLESS_DBUSER` works without Docker socket access. This avoids the complexity and security surface of mounting `/var/run/docker.sock`.

### D4 — Separate `entrypoint.sh` (not reusing `scripts/backup.sh`)

`scripts/backup.sh` is designed for host execution and uses `docker compose exec` for the pg_dump. Inside the container, that call would require the Docker socket. A separate `entrypoint.sh` with the same logic but using direct `pg_dump` keeps both scripts simple and avoids dual-purpose complexity.

### D5 — Volume paths inside the container

| Host path | Container path |
|---|---|
| `~/aktenraum/data` | `/backup/data` |
| `~/aktenraum/media` | `/backup/media` |
| `~/aktenraum/export` | `/backup/export` |
| `~/aktenraum/backup/restic-repo` | `/repo` |

`RESTIC_REPOSITORY=/repo` is set in the entrypoint.

## Risks / Trade-offs

- **Clock drift**: `crond` relies on the container's system clock (inherited from the Docker host). On Docker Desktop, the VM clock is synced to the Windows host — generally accurate to within a second.
- **Backup during compose down**: If `docker compose down` is run at 02:00, the backup job may be interrupted mid-run. Restic's atomicity guarantees the repo is never left in a corrupt state; the incomplete snapshot is simply absent.
- **No failure alerting**: A failed backup only appears in `docker compose logs backup`. Future work could add a healthcheck or a POST to a webhook on failure.
