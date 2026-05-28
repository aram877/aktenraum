# Runbook: Restore from backup

## Prerequisites

- A fresh Linux host with Docker, Docker Compose v2, and `restic` installed
- Access to the restic repository (local disk or B2)
- Your `RESTIC_PASSWORD` (the passphrase you set during first-time setup)
- This repository cloned to a directory of your choice (referred to below as `<repo>`)

---

## Step 1 — Identify the snapshot to restore

```bash
export RESTIC_REPOSITORY=~/aktenraum/backup/restic-repo
export RESTIC_PASSWORD=<your-passphrase>

# List recent snapshots
restic snapshots --tag aktenraum
```

Note the snapshot ID you want to restore (or use `latest`).

If restoring from B2:
```bash
export RESTIC_REPOSITORY=<your-B2-repo-URL>
export B2_ACCOUNT_ID=<id>
export B2_ACCOUNT_KEY=<key>
restic snapshots --tag aktenraum
```

---

## Step 2 — Create host directories

```bash
bash scripts/setup.sh
```

---

## Step 3 — Configure environment files

```bash
cp docker/.env.example docker/.env        # fill in REQUIRED values
cp docker/auto-tagger.env.example docker/auto-tagger.env  # fill in REQUIRED values
```

Use the **same** `PAPERLESS_DBPASS` and `PAPERLESS_SECRET_KEY` as the original instance, or Paperless will fail to decrypt stored data.

---

## Step 4 — Restore filesystem data

> **Important — confirm the paths first.** The default deployment backs up
> through the `backup` container, which records the in-container mount
> paths `/backup/data`, `/backup/media`, `/backup/export` (NOT
> `~/aktenraum/...`). The host-side `scripts/backup.sh` instead records
> `~/aktenraum/data` etc. Always check what the snapshot actually contains
> before restoring:
>
> ```bash
> restic ls latest --tag filesystem | head
> ```
>
> The examples below assume the **container** layout (`/backup/*`). If your
> snapshot shows `~/aktenraum/*`, substitute those paths.

restic always recreates the snapshot's absolute paths under `--target`, so
restore into a staging dir and then move the trees into your data directory
(`AKTENRAUM_DATA_DIR`, e.g. `~/aktenraum` on Linux/macOS or `D:/aktenraum`
on Windows):

```bash
SNAPSHOT=latest  # or a specific snapshot ID
DATA_DIR="${HOME}/aktenraum"   # set to your AKTENRAUM_DATA_DIR

restic restore "${SNAPSHOT}" --tag filesystem \
  --target /tmp/aktenraum-restore \
  --include /backup/data \
  --include /backup/media \
  --include /backup/export

# Move the restored trees into place
mv /tmp/aktenraum-restore/backup/data   "${DATA_DIR}/data"
mv /tmp/aktenraum-restore/backup/media  "${DATA_DIR}/media"
mv /tmp/aktenraum-restore/backup/export "${DATA_DIR}/export"
```

On Windows (Git Bash / PowerShell) set `DATA_DIR` to the `AKTENRAUM_DATA_DIR`
you configured in `docker/.env` (e.g. `D:/aktenraum`) and use a staging path
on the same drive.

---

## Step 5 — Start postgres only

```bash
cd docker
docker compose up -d postgres
# Wait for postgres to be healthy
docker compose ps postgres
```

---

## Step 6 — Restore the databases

There are **two** databases, each dumped to its own restic stream. Both must
be restored, or you will lose data silently:

- `paperless` (`postgres.dump`, tag `postgres`) — all documents, OCR, metadata
- `aktenraum` (`aktenraum.dump`, tag `postgres-aktenraum`) — SPA users and
  the per-type auto-approve rules. **Skipping this re-seeds the SPA to a
  single bootstrap user and resets all auto-approve config.**

Both target databases are created automatically on a fresh postgres volume
(`paperless` by the postgres image, `aktenraum` by
`docker/postgres-init/01-create-aktenraum-db.sh`), so they exist empty and
ready before you restore into them.

```bash
# Paperless DB
restic dump --tag postgres latest postgres.dump \
  | docker compose exec -T postgres \
      psql -U paperless paperless

# aktenraum DB (SPA users + auto-approve rules)
restic dump --tag postgres-aktenraum latest aktenraum.dump \
  | docker compose exec -T postgres \
      psql -U paperless aktenraum
```

(The `--tag` filters scope `latest` to the right DB stream — without them
`latest` may resolve to the filesystem snapshot, which contains no dump.)

---

## Step 7 — Start the full stack

```bash
docker compose up -d
```

Verify Paperless loads at `http://localhost:8000` and documents are present.

---

## Step 8 — Re-create the API token and restart auto-tagger

1. Log in to Paperless and create a new API token (Settings → API Tokens)
2. Update `docker/auto-tagger.env` with the new token
3. `docker compose restart auto-tagger`

---

## Verification checklist

- [ ] Paperless UI loads and shows expected document count
- [ ] A document with AI custom fields still shows those fields
- [ ] **aktenraum SPA (`http://localhost:8080`) login works with your original credentials** (confirms the `aktenraum` DB restored)
- [ ] **`/settings → Auto-Genehmigung` shows your configured per-type rules** (not the seeded defaults)
- [ ] Drop a test PDF into `~/aktenraum/consume/` and confirm it is ingested and tagged within 90 seconds
- [ ] Run `bash scripts/backup.sh` to create a fresh snapshot from the restored state
