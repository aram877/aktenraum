# Runbook: First-time setup

## Prerequisites

- Linux host with Docker and Docker Compose v2 installed
- `restic` installed (`apt install restic` or equivalent)
- This repository cloned to your workstation

## Steps

### 1. Create host directories

```bash
bash scripts/setup.sh
```

This creates `~/aktenraum/{consume,media,data,export,pgdata,backup/restic-repo}`.

### 2. Configure environment files

```bash
cp docker/.env.example docker/.env
cp docker/auto-tagger.env.example docker/auto-tagger.env
```

Open `docker/.env` and fill in the **REQUIRED** values:
- `PAPERLESS_SECRET_KEY` — generate with `openssl rand -hex 32`
- `PAPERLESS_ADMIN_PASSWORD` — choose a strong password
- `PAPERLESS_DBPASS` — choose a strong database password

Open `docker/auto-tagger.env` and fill in:
- `PAPERLESS_API_TOKEN` — create after Paperless first login (see step 5)
- `ANTHROPIC_API_KEY` — from console.anthropic.com (if using `LLM_BACKEND=anthropic`)

### 3. Start the stack

```bash
cd docker
docker compose up -d
docker compose logs -f paperless  # wait until you see "Ready"
```

Paperless will be available at `http://localhost:8000`.

### 4. Log in to Paperless

Open `http://localhost:8000` in your browser and log in with the admin credentials you set in `.env`.

### 5. Create an API token

In Paperless: **Settings → API Tokens → Add Token**. Copy the token and paste it into `docker/auto-tagger.env` as `PAPERLESS_API_TOKEN`.

Restart the auto-tagger to pick up the token:
```bash
docker compose restart auto-tagger
```

### 6. Bootstrap custom fields and tags

```bash
PAPERLESS_BASE_URL=http://localhost:8000 \
PAPERLESS_API_TOKEN=<your-token> \
bash scripts/bootstrap-paperless.sh
```

This creates the 12 AI custom fields and the `ai-suggested` / `ai-error` tags. Safe to run multiple times.

### 7. Set up backup

```bash
# Source your backup environment (or set these vars in your shell)
export RESTIC_PASSWORD=<choose-a-strong-passphrase>
export PAPERLESS_DBUSER=paperless
export PAPERLESS_DBPASS=<same-as-docker/.env>

# Run the first backup manually to verify it works
bash scripts/backup.sh

# Install the systemd timer for daily automated backups
sudo cp docker/systemd/aktenraum-backup.service /etc/systemd/system/
sudo cp docker/systemd/aktenraum-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aktenraum-backup.timer
systemctl status aktenraum-backup.timer
```

Store your `RESTIC_PASSWORD` securely (password manager). **You cannot restore backups without it.**

### 8. Test ingestion

Drop a PDF into `~/aktenraum/consume/`. Within a minute it should appear in Paperless with OCR text. Within 30–60 seconds of that, the auto-tagger should add `ai_*` custom fields and the `ai-suggested` tag.

---

## TODO: HTTPS / Tailscale

To expose Paperless securely beyond localhost, add a reverse proxy (nginx, Caddy) or join the host to your Tailscale network. This is intentionally deferred from v1.
