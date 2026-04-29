## ADDED Requirements

### Requirement: Backup container starts as part of the compose stack
`docker/docker-compose.yml` SHALL include a `backup` service built from `docker/backup/Dockerfile`. It SHALL depend on `postgres` being healthy. It SHALL use `restart: unless-stopped` and join the `internal` network.

#### Scenario: Backup service starts with the stack
- **WHEN** `docker compose up -d` is run with a valid `backup.env`
- **THEN** the `backup` container reaches running state and `docker compose logs backup` shows the crond process started

### Requirement: Backup runs daily at 02:00 via crond
The container SHALL run Alpine `crond` as PID 1 (`crond -f -l 2`). A crontab file SHALL schedule `entrypoint.sh` at `0 2 * * *`. Cron output SHALL go to stdout so it is visible via `docker compose logs backup`.

#### Scenario: Cron fires at the scheduled time
- **WHEN** the system clock reaches 02:00
- **THEN** `entrypoint.sh` executes and a new restic snapshot appears in the repo

### Requirement: Postgres dump is included without a temp file on disk
`entrypoint.sh` SHALL connect to postgres directly via hostname `postgres` using `pg_dump -h postgres` and pipe the output into `restic backup --stdin --stdin-filename postgres.dump`. No `.sql` file SHALL be written to disk.

#### Scenario: Postgres dump is streamed into restic
- **WHEN** `entrypoint.sh` runs
- **THEN** the restic snapshot contains a file named `postgres.dump` and no `.sql` file exists on any mounted volume

### Requirement: Data directories are backed up from mounted volumes
`entrypoint.sh` SHALL back up `/backup/data`, `/backup/media`, and `/backup/export` (mounted from the host). These SHALL be included in the same restic snapshot as the postgres dump via separate `restic backup` calls tagged `aktenraum`.

#### Scenario: All data dirs appear in snapshot
- **WHEN** a backup completes successfully
- **THEN** `restic snapshots` lists a snapshot containing paths for data, media, export, and postgres.dump

### Requirement: Retention policy is enforced after each backup
`entrypoint.sh` SHALL run `restic forget --prune --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --tag aktenraum` after each backup.

#### Scenario: Old snapshots pruned automatically
- **WHEN** more than 7 daily snapshots exist
- **THEN** `restic forget --prune` removes the oldest, leaving at most 7 daily snapshots

### Requirement: Restic repository is initialised on first run
`entrypoint.sh` SHALL check whether the repository at `/repo` is initialised and run `restic init` if not, before attempting any backup.

#### Scenario: First run initialises and backs up
- **WHEN** `entrypoint.sh` runs against an empty `/repo` directory
- **THEN** it initialises the repo and completes a snapshot without error

### Requirement: Backup credentials are supplied via env file
`docker/backup.env.example` SHALL document all required env vars: `RESTIC_PASSWORD`, `PAPERLESS_DBUSER`, `PAPERLESS_DBPASS`. Optional B2 vars: `BACKUP_B2_BUCKET`, `RESTIC_REPOSITORY_2`, `B2_ACCOUNT_ID`, `B2_ACCOUNT_KEY`. The env file SHALL be gitignored.

#### Scenario: Missing RESTIC_PASSWORD causes clear failure
- **WHEN** the backup container starts without `RESTIC_PASSWORD` set
- **THEN** `entrypoint.sh` exits with a non-zero code and logs an error message naming the missing variable
