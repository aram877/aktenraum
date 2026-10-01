# Runbook: First-time setup

## Prerequisites

- Linux or macOS host with Docker and Docker Compose v2 installed
- An LLM backend: [Ollama](https://ollama.com) on the host (default; `ollama pull qwen2.5:14b-instruct-q8_0` and `ollama pull qwen3-embedding:4b`) or an Anthropic API key
- `restic` installed only if you opt into the host-side systemd timer (step 7). The Dockerised `backup` service ships its own restic
- This repository cloned to your workstation
- [`task`](https://taskfile.dev) — strongly recommended (`brew install go-task` / `winget install Task.Task`). Every step below has a `task` shortcut.

## Configuration model

There is exactly **one** env file: `docker/.env`, loaded by every service in `docker/docker-compose.yml` (`env_file: .env`). Its committed template is `docker/.env.example`. `scripts/bootstrap-secrets.sh` creates `docker/.env` from the template if it is missing and fills every empty secret except `PAPERLESS_API_TOKEN`. Two values you always set by hand:

- `AKTENRAUM_DATA_DIR` — absolute path to the data directory (e.g. `/Users/you/aktenraum`, `/srv/aktenraum`, `D:/aktenraum`). Compose refuses to start while it is empty. Never change it without moving the data first.
- `PAPERLESS_API_TOKEN` — minted after Paperless first boots (step 5).

## The fast path (with `task`)

```bash
task setup
```

This runs `scripts/setup.sh` (host dirs) → `scripts/bootstrap-secrets.sh` (fills secrets in `docker/.env`, prints the generated admin/SPA/restic passwords once) → `docker compose up -d` → `scripts/fix-token.sh` (mints the Paperless API token into `docker/.env` and recreates both Node services) → `scripts/bootstrap-paperless.sh` inside the paperless container → `restic init` in the backup container → a first snapshot.

`task setup` runs `scripts/first-run.sh`: it creates `docker/.env`, asks for `AKTENRAUM_DATA_DIR` (Enter accepts the suggested folder), pulls the Ollama models and finishes with a verified first backup and the login. Nothing has to be prepared by hand.

The remaining sections walk through every step in detail; do them only if `task setup` doesn't fit your setup or you want the raw commands.

## Steps (raw)

### 1. Generate `docker/.env`

```bash
bash scripts/bootstrap-secrets.sh
```

This copies `docker/.env.example` → `docker/.env` if absent and fills `PAPERLESS_SECRET_KEY`, `PAPERLESS_ADMIN_PASSWORD`, `PAPERLESS_DBPASS`, `JWT_SECRET`, `BOOTSTRAP_PASSWORD`, `WEBHOOK_SECRET` and `RESTIC_PASSWORD`. Record the passwords it prints — they are shown only once. Re-runs are no-ops once everything is populated.

Then open `docker/.env` and set:
- `AKTENRAUM_DATA_DIR` — absolute data path (required)
- `LLM_BACKEND` — `ollama` (default) or `anthropic`; with `anthropic`, also set `ANTHROPIC_API_KEY` (from console.anthropic.com)
- `COOKIE_SECURE=false` — only for plain-HTTP access on `http://localhost:8080` from the host itself

### 2. Create host directories

```bash
bash scripts/setup.sh
```

This reads `AKTENRAUM_DATA_DIR` (from the environment or `docker/.env`) and creates `consume`, `media`, `data`, `export`, `pgdata`, `qdrant` and `backup/restic-repo` under it.

### 3. Start the stack

```bash
docker compose --project-directory docker up -d
docker compose --project-directory docker logs -f paperless  # wait until you see "Ready"
```

Paperless will be available at `http://localhost:8000`; the aktenraum SPA at `http://localhost:8080`.

### 4. Log in to Paperless

Open `http://localhost:8000` and log in with `PAPERLESS_ADMIN_USER` / `PAPERLESS_ADMIN_PASSWORD` from `docker/.env`.

### 5. Create an API token

Either in Paperless (**Settings → API Tokens → Add Token**) or via the API:

```bash
curl -s -X POST http://localhost:8000/api/token/ -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<PAPERLESS_ADMIN_PASSWORD>"}'
```

Paste the token into `docker/.env` as `PAPERLESS_API_TOKEN`, then recreate both Node services so they re-read the file (`restart` does not re-read env files):

```bash
docker compose --project-directory docker up -d auto-tagger aktenraum-api
```

### 6. Bootstrap custom fields and tags

```bash
PAPERLESS_BASE_URL=http://localhost:8000 \
PAPERLESS_API_TOKEN=<your-token> \
bash scripts/bootstrap-paperless.sh
```

This creates the 12 AI custom fields, the six lifecycle tags (`ai-pending`, `ai-approved`, `ai-rejected`, `ai-propagated`, `ai-propagation-error`, `ai-error`) and the auxiliary tags (`ai-auto-approved`, `ai-low-confidence`, `ai-duplicate`, `ai-duplicate-dismissed`, `email-ingested`, `wichtig`). Safe to run multiple times.

### 6.5. (optional) Set up email ingestion

If you want documents emailed to a mailbox to flow into the inbox automatically, fill in the `AKTENRAUM_MAIL_*` section in `docker/.env`:

```ini
AKTENRAUM_MAIL_IMAP_SERVER=imap.gmail.com
AKTENRAUM_MAIL_IMAP_PORT=993
AKTENRAUM_MAIL_IMAP_SECURITY=SSL
AKTENRAUM_MAIL_USERNAME=docs@example.com
AKTENRAUM_MAIL_PASSWORD=<app-password>          # Gmail: https://myaccount.google.com/apppasswords
AKTENRAUM_MAIL_FOLDER=INBOX
AKTENRAUM_MAIL_ACTION=MARK_READ                 # MARK_READ | FLAG | DELETE
AKTENRAUM_MAIL_FILTER_FROM=                     # optional sender allowlist (substring match)
```

Then re-run the bootstrap script — it auto-loads the `AKTENRAUM_MAIL_*` vars from `docker/.env` and provisions a Paperless mail account + rule:

```bash
PAPERLESS_BASE_URL=http://localhost:8000 \
PAPERLESS_API_TOKEN=<your-token> \
bash scripts/bootstrap-paperless.sh
```

Paperless polls the mailbox every ~10 minutes. Attachments matching `*.pdf,*.png,*.jpg,*.jpeg,*.tif,*.tiff` flow through the same pipeline as files dropped into `<AKTENRAUM_DATA_DIR>/consume/` — they OCR, the auto-tagger picks them up, and they land in the review queue. Each ingested doc gets the `email-ingested` tag so you can filter them in Library (`?tags=email-ingested`).

Re-running the script with the same `AKTENRAUM_MAIL_NAME` updates the existing account in place (password rotation works). Unsetting `AKTENRAUM_MAIL_IMAP_SERVER` does **not** delete the account — remove it manually via Paperless's admin UI (Settings → Mail) if you want to stop ingestion.

### 7. Set up backup

The default deployment uses the Dockerised `backup` service, which runs crond inside a container and fires `entrypoint.sh` daily at 02:00. It reads `RESTIC_PASSWORD` and `PAPERLESS_DBPASS` from `docker/.env` (generated in step 1) and writes to `<AKTENRAUM_DATA_DIR>/backup/restic-repo` (mounted at `/repo`). The entrypoint does not create a missing repository, so initialise it once and take a first snapshot:

```bash
docker compose --project-directory docker exec -T backup sh -c \
  'restic -r /repo snapshots > /dev/null 2>&1 || restic -r /repo init'
docker compose --project-directory docker exec backup /usr/local/bin/entrypoint.sh
```

(Git Bash: prefix with `MSYS_NO_PATHCONV=1` and use `//usr/local/bin/entrypoint.sh`.) Verify with `task backup:verify`.

Store `RESTIC_PASSWORD` securely (password manager). **You cannot restore backups without it.**

#### Optional: host-side systemd timer instead of the container

Only for Linux hosts that should run `scripts/backup.sh` from the host. The unit reads its own env file, `~/aktenraum/.backup.env` (separate from `docker/.env`), and `scripts/backup.sh` takes its base path from `AKTENRAUM_DATA_DIR` (environment, else `docker/.env`).

```bash
# 1. Create the env file the systemd unit reads (copy values from docker/.env)
cat > ~/aktenraum/.backup.env <<EOF
RESTIC_PASSWORD=<same-as-docker/.env>
PAPERLESS_DBUSER=paperless
PAPERLESS_DBPASS=<same-as-docker/.env>
EOF
chmod 600 ~/aktenraum/.backup.env

# 2. Test a manual run
set -a; . ~/aktenraum/.backup.env; set +a
bash scripts/backup.sh

# 3. Substitute the repo path placeholder, then install the unit + timer
REPO_PATH="$(pwd)"
sed "s|__REPO_PATH__|${REPO_PATH}|" docker/systemd/aktenraum-backup.service \
  | sudo tee /etc/systemd/system/aktenraum-backup@${USER}.service > /dev/null
sudo cp docker/systemd/aktenraum-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aktenraum-backup.timer
systemctl status aktenraum-backup.timer
```

### 8. Test ingestion

Drop a PDF into `<AKTENRAUM_DATA_DIR>/consume/` (or upload it at `http://localhost:8080/upload`). Within a minute it should appear in Paperless with OCR text. Paperless's `post_consume` webhook then triggers the auto-tagger, which adds the `ai_*` custom fields and the `ai-pending` tag (or `ai-approved` + `ai-auto-approved` if an auto-approve rule matches); the 30-second poller is the fallback. The document appears in the SPA under `/library?tab=review`.

---

## Remote access (HTTPS / Tailscale)

Remote access during the testing phase goes through Tailscale: see [`tailscale-remote-access.md`](tailscale-remote-access.md).
