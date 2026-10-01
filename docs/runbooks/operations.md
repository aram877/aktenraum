# Runbook: Daily operations

Commands run from the repository root after `DC="docker compose --project-directory docker"`; every `task` shortcut is defined in `Taskfile.yml`.

## Starting and stopping the stack

```bash
task start                 # $DC up -d — also recreates services whose docker/.env values changed
task stop                  # $DC down — data is preserved under AKTENRAUM_DATA_DIR
task status                # $DC ps

$DC up -d auto-tagger      # recreate one service (re-reads docker/.env)
$DC restart auto-tagger    # restart only — does NOT re-read docker/.env
```

Configuration lives in one file, `docker/.env`. After editing it, use `up -d`, not `restart`.

## Viewing logs

```bash
task logs                  # all services
task logs SVC=auto-tagger  # one service
$DC logs --tail=100 paperless
```

## Ingesting a document

Upload through the SPA at `http://localhost:8080/upload`, or drop any PDF, image, or supported file into `<AKTENRAUM_DATA_DIR>/consume/`. Paperless picks it up, runs OCR and calls the auto-tagger's `post_consume` webhook.

## Checking auto-tagger output

The webhook triggers extraction immediately; the 30-second poller is the safety net. Afterwards the document carries populated `ai_*` custom fields and one lifecycle tag:

- `ai-pending` — awaiting review (shown in the SPA under `/library?tab=review`)
- `ai-approved` + `ai-auto-approved` — an auto-approve rule matched; propagation follows
- `ai-error` — extraction failed

On `ai-error`, or when auto-approve did not fire as expected:

```bash
$DC logs --tail=50 auto-tagger
$DC logs auto-tagger | grep routing_decision   # the reason=… field names the gate that blocked auto-approve
```

## Reviewing AI suggestions

Review happens in the SPA: `/library?tab=review` lists every `ai-pending` document; `/inbox/<id>` shows the PDF next to the editable AI fields with Approve (`a`) / Reject (`r`). Approve swaps `ai-pending` → `ai-approved` and pings the auto-tagger, which propagates the fields onto Paperless's native correspondent / document type / date / tags and tags `ai-propagated`.

| Tag | Meaning |
|---|---|
| `ai-pending` | Extracted, awaiting review |
| `ai-approved` | Approved — propagation copies the AI fields onto native Paperless fields |
| `ai-rejected` | Rejected — no propagation, no retry |
| `ai-propagated` | Native Paperless fields written; final success state |
| `ai-propagation-error` | Propagation failed mid-run; needs manual intervention |
| `ai-error` | Extraction failed |

Auxiliary tags (`ai-auto-approved`, `ai-low-confidence`, `ai-duplicate`, `ai-duplicate-dismissed`, `ai-index-error`, `email-ingested`, `wichtig`) coexist with a lifecycle tag. The auto-tagger skips any document that carries one of the six lifecycle tags. To re-run extraction, use **Erneut verarbeiten** in the SPA (clears the lifecycle tags and triggers the auto-tagger).

## Backups (Dockerised `backup` service)

The `backup` service runs `crond` inside its container and fires `entrypoint.sh` daily at 02:00. It reads `RESTIC_PASSWORD` and `PAPERLESS_DBPASS` from `docker/.env` and writes to `<AKTENRAUM_DATA_DIR>/backup/restic-repo` (mounted at `/repo`). Each run snapshots `data`, `media`, `export` plus dumps of the `paperless` and `aktenraum` databases, then applies 7 daily / 4 weekly / 12 monthly retention. A `restic check --read-data-subset=5%` runs on Sundays.

```bash
# Logs
$DC logs --tail=50 backup

# Trigger a backup run now (Git Bash: MSYS_NO_PATHCONV=1 and //usr/local/bin/entrypoint.sh)
$DC exec backup /usr/local/bin/entrypoint.sh

# List snapshots
$DC exec -e RESTIC_REPOSITORY=/repo backup restic snapshots --tag aktenraum --latest 5

# Integrity check
$DC exec -e RESTIC_REPOSITORY=/repo backup restic check --read-data-subset=5%

# Non-destructive DR rehearsal: check + restore to staging + validate both DB dumps
task backup:verify
```

The entrypoint does **not** create a missing repository; it fails loudly unless `BACKUP_AUTO_INIT=true`. `task setup` performs the one-time `restic init`.

### Optional: host-side systemd timer

Only if you installed `docker/systemd/aktenraum-backup.{service,timer}` (see `first-time-setup.md`, step 7). That path runs `scripts/backup.sh` on the host with its own env file, `~/aktenraum/.backup.env`.

```bash
systemctl status aktenraum-backup.timer
journalctl -u 'aktenraum-backup@*' --since yesterday
```
