# Runbook: Daily operations

## Starting and stopping the stack

```bash
cd ~/Development/document-organizer/docker

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
3. Check the **Tags** — `ai-suggested` means the AI has processed it and is awaiting confirmation

If you see `ai-error` instead, check the auto-tagger logs:
```bash
docker compose logs --tail=50 auto-tagger
```

## Confirming AI suggestions

A document tagged `ai-suggested` has AI-generated metadata that has not been confirmed. To confirm:

1. Open the document in Paperless
2. Review the `ai_*` custom fields
3. Make any corrections (edit directly in the Paperless UI)
4. Remove the `ai-suggested` tag

The document is now considered authoritative — the auto-tagger will not re-process it.

## Checking backup status

```bash
export RESTIC_REPOSITORY=~/aktenraum/backup/restic-repo
export RESTIC_PASSWORD=<your-passphrase>

# List recent snapshots
restic snapshots --tag aktenraum --last 5

# Check systemd timer
systemctl status aktenraum-backup.timer
journalctl -u aktenraum-backup.service --since yesterday
```

## Manually triggering a backup

```bash
RESTIC_PASSWORD=<your-passphrase> \
PAPERLESS_DBPASS=<db-password> \
bash ~/Development/document-organizer/scripts/backup.sh
```
