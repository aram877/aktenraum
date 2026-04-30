# Runbook: Daily operations

## Starting and stopping the stack

All compose commands assume your working directory is the `docker/` subdirectory of your local clone. Adjust the path to wherever you cloned this repo.

```bash
cd <repo>/docker

# Start all services
docker compose up -d

# Stop all services (data is preserved in volumes)
docker compose down

# Restart a single service
docker compose restart auto-tagger
```

## Viewing logs

```bash
# All services
docker compose logs -f

# Auto-tagger only
docker compose logs -f auto-tagger

# Last 100 lines from Paperless
docker compose logs --tail=100 paperless
```

## Ingesting a document

Drop any PDF, image, or supported file into `~/aktenraum/consume/`. Paperless picks it up automatically (usually within 30 seconds) and runs OCR.

```bash
cp ~/Downloads/rechnung-2026-04.pdf ~/aktenraum/consume/
```

## Checking auto-tagger output

After a document is ingested by Paperless, the auto-tagger processes it within the next poll cycle (default 30 seconds). In the Paperless UI:

1. Open the document
2. Scroll to **Custom Fields** — you should see populated `ai_*` fields
3. Check the **Tags** — `ai-pending` means the AI has processed it and is awaiting your review

If you see `ai-error` instead, check the auto-tagger logs:
```bash
docker compose logs --tail=50 auto-tagger
```

## Reviewing AI suggestions (three-state workflow)

A document tagged `ai-pending` has AI-generated metadata waiting for review. The lifecycle uses six tags (created by the bootstrap script):

| Tag | Meaning |
|---|---|
| `ai-pending` | Extracted, awaiting review |
| `ai-approved` | User approved — propagation watcher copies the AI fields onto native Paperless entities |
| `ai-rejected` | User rejected — no propagation, do not retry |
| `ai-propagated` | Native Paperless fields have been written from the AI extraction |
| `ai-propagation-error` | Propagation pipeline failed mid-run |
| `ai-error` | Extraction failed |

To review a `ai-pending` document:

1. Open the document in Paperless
2. Review the `ai_*` custom fields and edit directly if needed
3. Replace `ai-pending` with `ai-approved` (accept) or `ai-rejected` (discard)

The auto-tagger skips any document carrying any of the six lifecycle tags, so once you tag it `ai-approved` or `ai-rejected` the document will not be re-processed.

## Checking backup status

```bash
export RESTIC_REPOSITORY=~/aktenraum/backup/restic-repo
export RESTIC_PASSWORD=<your-passphrase>

# List recent snapshots
restic snapshots --tag aktenraum --latest 5

# Check systemd timer
systemctl status aktenraum-backup.timer
journalctl -u aktenraum-backup.service --since yesterday
```

## Manually triggering a backup

```bash
RESTIC_PASSWORD=<your-passphrase> \
PAPERLESS_DBPASS=<db-password> \
bash <repo>/scripts/backup.sh
```

---

## Backup container (Docker-based scheduler)

The `backup` service runs `crond` inside Docker and fires the backup daily at 02:00.

### Check backup logs

```bash
docker compose logs backup
docker compose logs --tail=50 backup   # last 50 lines
```

### Trigger a manual backup run immediately

```bash
docker compose exec backup /usr/local/bin/entrypoint.sh
```

### List snapshots from inside the container

```bash
docker compose exec backup restic snapshots --tag aktenraum
```

### First-time setup

Before starting the backup service, create `docker/backup.env` from the example and fill in the required values:

```bash
cp docker/backup.env.example docker/backup.env
# edit backup.env: set RESTIC_PASSWORD and PAPERLESS_DBPASS
docker compose up -d backup
```

The restic repository is automatically initialised on the first run if it does not exist.
