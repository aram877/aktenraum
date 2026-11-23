# Backup

> Moved out of CLAUDE.md to keep the always-loaded context small. Read this when working in this area.

## Backup

- **Container**: `backup` service. crond runs `backup-if-due.sh` hourly (and `start.sh` once at container start): it runs `entrypoint.sh` when the newest complete backup is older than `BACKUP_INTERVAL_HOURS` (20). Catch-up instead of a fixed time — see the Known-gotcha row. Runs are serialised with an flock (`/tmp/aktenraum-backup.lock`), so a manual run during a scheduled one skips.
- **What**: two live postgres dumps first — `paperless` (`postgres.dump`, tag `postgres`) and `aktenraum` (`aktenraum.dump`, tag `postgres-aktenraum`) — then `data/`, `media/`, `export/` as one tar stream `aktenraum-files.tar` (tag `filesystem`, `restic backup --stdin-from-command -- tar-data.sh`; logs and lock files excluded). All stdin-piped, no temp files.
- **Health**: the container's healthcheck (`healthcheck.sh`, hourly) is unhealthy when `RESTIC_PASSWORD` is missing, the repo can't be opened, or any of the three tags is older than 36 h — `docker compose ps` shows it. It also writes `/status/backup-status.json` into the `backup-status` volume (plus `last-run` from every entrypoint run); aktenraum-api serves it at `GET /api/health/backup` (`ok`/`stale`/`failing`/`unknown`, `failing` also when the file is > 3 h old), and the SPA shows an amber "Backup veraltet" / red "Backup-Fehler" nav pill linking to `/settings#backup`.
- **Retention**: 7 daily, 4 weekly, 12 monthly
- **Repo**: `~/aktenraum/backup/restic-repo/` (mounted at `/repo` in container)
- **Manual run**: `docker compose --project-directory docker exec backup /usr/local/bin/entrypoint.sh` (Git Bash: `MSYS_NO_PATHCONV=1` and `//usr/local/bin/entrypoint.sh`)
- **List snapshots**: `docker compose --project-directory docker exec -e RESTIC_REPOSITORY=/repo backup restic snapshots --tag aktenraum`
- **Integrity check**: `docker compose --project-directory docker exec -e RESTIC_REPOSITORY=/repo backup restic check --read-data-subset=5%` (also runs inside the entrypoint when the last check is ≥ 7 days old — marker `/status/last-check` — and as part of `task backup:verify`)
- **DR rehearsal (non-destructive)**: `task backup:verify` — `restic check` + filesystem restore to a staging dir + validates both DB dumps are present and look like pg_dumps. Run this to actually trust the backup.
- **Restore**: see [`docs/runbooks/restore.md`](docs/runbooks/restore.md) (filesystem `/backup/*` paths + both databases)
- **Auto-init**: the entrypoint does NOT silently create a missing repo — it fails loudly unless `BACKUP_AUTO_INIT=true`. First-time init is done by `task setup`.

---

