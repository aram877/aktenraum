## ADDED Requirements

### Requirement: Restic repository is initialised before first backup
`scripts/backup.sh` SHALL check whether the local restic repository at `~/aktenraum/backup/restic-repo/` is initialised, and initialise it if not, before attempting any backup operation.

#### Scenario: First run initialises and backs up
- **WHEN** `scripts/backup.sh` is run on a host with no existing restic repo
- **THEN** it initialises the repo and completes the first backup snapshot without error

### Requirement: Backup covers all persistent Paperless data
Each backup run SHALL include: `~/aktenraum/data/`, `~/aktenraum/media/`, `~/aktenraum/export/`, and a live postgres dump (via `pg_dump` piped directly into `restic backup --stdin`). No plaintext dump file SHALL be written to disk.

#### Scenario: Postgres dump is included without touching disk
- **WHEN** `scripts/backup.sh` runs while the postgres container is running
- **THEN** the restic snapshot includes a stream labelled `postgres.dump` and no `.sql` file appears in the filesystem

#### Scenario: Backup runs while Paperless is active
- **WHEN** `scripts/backup.sh` is run while documents are being ingested
- **THEN** the backup completes without error (eventual consistency is acceptable for personal use)

### Requirement: Retention policy is enforced automatically
After each backup, `scripts/backup.sh` SHALL run `restic forget --prune` with the policy: keep 7 daily, 4 weekly, 12 monthly snapshots.

#### Scenario: Old snapshots are pruned after retention window
- **WHEN** more than 7 daily snapshots exist in the local repo
- **THEN** `restic forget --prune` removes the oldest ones, leaving at most 7 daily snapshots

### Requirement: Backup is scheduled via systemd timer
A systemd unit pair (`aktenraum-backup.service` + `aktenraum-backup.timer`) SHALL be provided in `docker/systemd/`. The timer SHALL run daily at 02:00 local time. Installation instructions SHALL be in the operations runbook.

#### Scenario: Timer appears as active after installation
- **WHEN** the operator runs the installation commands from the runbook
- **THEN** `systemctl status aktenraum-backup.timer` shows `active (waiting)`

### Requirement: Optional B2 remote backup is supported
If the environment variable `BACKUP_B2_BUCKET` is set, `scripts/backup.sh` SHALL also push the snapshot to a B2 bucket configured via restic's standard env vars (`RESTIC_REPOSITORY_2`, `B2_ACCOUNT_ID`, `B2_ACCOUNT_KEY`). If the variable is unset, the remote step SHALL be silently skipped.

#### Scenario: B2 push is skipped when not configured
- **WHEN** `scripts/backup.sh` runs with `BACKUP_B2_BUCKET` unset
- **THEN** it completes with only the local snapshot and no B2 API calls are made

#### Scenario: B2 push runs when configured
- **WHEN** `BACKUP_B2_BUCKET` is set and valid B2 credentials are in the environment
- **THEN** `scripts/backup.sh` copies the snapshot to the B2 bucket

### Requirement: Restore procedure is documented and tested
`docs/runbooks/restore.md` SHALL document the exact commands to restore from a restic snapshot to a fresh host. The runbook SHALL cover: listing snapshots, restoring files, restoring the postgres dump, and restarting the stack.

#### Scenario: Restore runbook is self-contained
- **WHEN** an operator follows `docs/runbooks/restore.md` on a fresh Linux host with restic and Docker installed
- **THEN** they can restore a working Paperless instance from a backup snapshot without consulting any other document
