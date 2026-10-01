# Runbook: Restore from backup

## Prerequisites

- A fresh Linux host with Docker, Docker Compose v2, and `restic` installed
- Access to the restic repository (local disk or B2)
- Your `RESTIC_PASSWORD` (the passphrase you set during first-time setup)
- This repository cloned to a directory of your choice (referred to below as `<repo>`)

---

## Step 1 — Identify the snapshot to restore

```bash
export RESTIC_REPOSITORY=<AKTENRAUM_DATA_DIR>/backup/restic-repo   # e.g. ~/aktenraum/backup/restic-repo
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

## Step 2 — Configure `docker/.env`

All services load one env file, `docker/.env`. Restore it from your password manager / offline copy if you have one. Otherwise:

```bash
cp docker/.env.example docker/.env
```

and fill in at least:

- `AKTENRAUM_DATA_DIR` — the absolute data path to restore into
- `PAPERLESS_SECRET_KEY` — the **same** value as the original instance, or Paperless cannot decrypt stored data
- `RESTIC_PASSWORD` — the backup passphrase
- `PAPERLESS_DBPASS`, `PAPERLESS_ADMIN_PASSWORD`, `JWT_SECRET`, `WEBHOOK_SECRET`, `BOOTSTRAP_PASSWORD` — reuse the originals or generate new ones with `bash scripts/bootstrap-secrets.sh` (it only fills empty values)

If you have the original `PAPERLESS_API_TOKEN`, keep it — the token is stored in the `paperless` database you are about to restore. Otherwise leave it empty and mint one in step 8.

---

## Step 3 — Create host directories

```bash
bash scripts/setup.sh
```

This reads `AKTENRAUM_DATA_DIR` from `docker/.env` and creates `consume`, `media`, `data`, `export`, `pgdata`, `qdrant` and `backup/restic-repo` under it.

---

## Step 4 — Restore filesystem data

Since 2026-10-01 the backup container stores `data/`, `media/` and `export/`
as one tar stream, `aktenraum-files.tar` (tag `filesystem`). restic's own file
reader fails with `input/output error` on Docker Desktop bind mounts, so
`tar` reads the files instead. Snapshots taken before that date contain the
directory tree but **no document files** and are useless for a restore.

Check the snapshot first — it should list `/aktenraum-files.tar`:

```bash
restic ls latest --tag filesystem
```

Extract it straight into your data directory (`AKTENRAUM_DATA_DIR`, e.g.
`~/aktenraum` on macOS/Linux or `D:/aktenraum` on Windows). The empty
`data/`, `media/` and `export/` folders from step 3 are fine; anything else in
them is overwritten:

```bash
SNAPSHOT=latest  # or a specific snapshot ID
DATA_DIR="${HOME}/aktenraum"   # set to your AKTENRAUM_DATA_DIR

restic dump --tag filesystem "${SNAPSHOT}" aktenraum-files.tar | tar -x -C "${DATA_DIR}"
ls "${DATA_DIR}/media/documents/originals" | head
```

The same works from inside the backup container (the repo is at `/repo`):

```bash
docker compose --project-directory docker run --rm --no-deps \
  -e RESTIC_REPOSITORY=/repo -v "${DATA_DIR}:/restore" --entrypoint sh backup \
  -c 'restic dump --tag filesystem latest aktenraum-files.tar | tar -x -C /restore'
```

On Windows (Git Bash) set `DATA_DIR` to the `AKTENRAUM_DATA_DIR` you
configured in `docker/.env` (e.g. `D:/aktenraum`) and prefix the container
command with `MSYS_NO_PATHCONV=1`.

---

## Step 5 — Start postgres only

```bash
docker compose --project-directory docker up -d postgres
# Wait for postgres to be healthy
docker compose --project-directory docker ps postgres
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
  | docker compose --project-directory docker exec -T postgres \
      psql -U paperless paperless

# aktenraum DB (SPA users + auto-approve rules)
restic dump --tag postgres-aktenraum latest aktenraum.dump \
  | docker compose --project-directory docker exec -T postgres \
      psql -U paperless aktenraum
```

(The `--tag` filters scope `latest` to the right DB stream — without them
`latest` may resolve to the filesystem snapshot, which contains no dump.)

---

## Step 7 — Start the full stack

```bash
docker compose --project-directory docker up -d
```

Verify Paperless loads at `http://localhost:8000` and documents are present.

---

## Step 8 — Re-create the API token

Skip this step if `docker/.env` already holds the original token and the services do not log 401s.

1. Log in to Paperless and create a new API token (Settings → API Tokens), or `POST http://localhost:8000/api/token/` with the admin credentials
2. Set `PAPERLESS_API_TOKEN` in `docker/.env`
3. Recreate both Node services so they re-read the file: `docker compose --project-directory docker up -d auto-tagger aktenraum-api`

---

## Verification checklist

- [ ] Paperless UI loads and shows expected document count
- [ ] A document with AI custom fields still shows those fields
- [ ] **aktenraum SPA (`http://localhost:8080`) login works with your original credentials** (confirms the `aktenraum` DB restored)
- [ ] **`/settings → Auto-Genehmigung` shows your configured per-type rules** (not the seeded defaults)
- [ ] Drop a test PDF into `<AKTENRAUM_DATA_DIR>/consume/` and confirm it is ingested and tagged within 90 seconds
- [ ] Ask AI returns chunk-grounded answers; if not, rebuild the vector index with `bash scripts/backfill-rag-index.sh` (Qdrant data is not part of the backup)
- [ ] Take a fresh snapshot from the restored state: `docker compose --project-directory docker exec backup /usr/local/bin/entrypoint.sh`
