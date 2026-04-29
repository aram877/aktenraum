## 1. Backup Container

- [ ] 1.1 Create `docker/backup/` directory
- [ ] 1.2 Write `docker/backup/Dockerfile`: Alpine base, install `restic` and `postgresql-client` and `bash`, copy `entrypoint.sh` and `crontab`, set entrypoint to `crond -f -l 2`
- [ ] 1.3 Write `docker/backup/entrypoint.sh`: check `RESTIC_PASSWORD` set, init repo if absent, backup `/backup/data` + `/backup/media` + `/backup/export`, pipe `pg_dump` into restic stdin, run `restic forget --prune` with retention policy, optional B2 copy
- [ ] 1.4 Write `docker/backup/crontab`: schedule `entrypoint.sh` at `0 2 * * *`

## 2. Compose Integration

- [ ] 2.1 Add `backup` service to `docker/docker-compose.yml`: build from `./backup`, `depends_on: postgres: condition: service_healthy`, `restart: unless-stopped`, `internal` network, volume mounts for data/media/export/repo, `env_file: backup.env`
- [ ] 2.2 Write `docker/backup.env.example`: document `RESTIC_PASSWORD` (required), `PAPERLESS_DBUSER` (default: paperless), `PAPERLESS_DBPASS` (required), and optional B2 vars

## 3. Documentation and Final Check

- [ ] 3.1 Update `docs/runbooks/operations.md`: add section for checking backup logs (`docker compose logs backup`), triggering a manual run (`docker compose exec backup /usr/local/bin/entrypoint.sh`), and listing snapshots from inside the container
- [ ] 3.2 Start the backup service (`docker compose up -d --build backup`) and confirm it reaches running state
- [ ] 3.3 Trigger a manual backup run and verify a snapshot appears in the restic repo
