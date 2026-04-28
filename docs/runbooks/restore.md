# Runbook: Restore from backup

## Prerequisites

- A fresh Linux host with Docker, Docker Compose v2, and `restic` installed
- Access to the restic repository (local disk or B2)
- Your `RESTIC_PASSWORD` (the passphrase you set during first-time setup)
- This repository cloned to `~/Development/document-organizer`

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

```bash
SNAPSHOT=latest  # or a specific snapshot ID

restic restore "${SNAPSHOT}" \
  --target / \
  --include /home/<user>/aktenraum/data \
  --include /home/<user>/aktenraum/media \
  --include /home/<user>/aktenraum/export
```

Replace `<user>` with your Linux username.

---

## Step 5 — Start postgres only

```bash
cd docker
docker compose up -d postgres
# Wait for postgres to be healthy
docker compose ps postgres
```

---

## Step 6 — Restore the postgres dump

Find the snapshot ID for the postgres dump (it was backed up separately with `--stdin-filename postgres.dump`):

```bash
restic snapshots --tag postgres
```

```bash
restic dump "${SNAPSHOT}" postgres.dump \
  | docker compose exec -T postgres \
      psql -U paperless paperless
```

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
- [ ] Drop a test PDF into `~/aktenraum/consume/` and confirm it is ingested and tagged within 90 seconds
- [ ] Run `bash scripts/backup.sh` to create a fresh snapshot from the restored state
