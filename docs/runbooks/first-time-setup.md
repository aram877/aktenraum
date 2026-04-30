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

This creates the 12 AI custom fields and the six lifecycle tags (`ai-pending`, `ai-approved`, `ai-rejected`, `ai-propagated`, `ai-propagation-error`, `ai-error`). Safe to run multiple times.

### 7. Set up backup

The default deployment uses the Dockerised backup service (compose service `backup`), which runs crond inside a container and fires `entrypoint.sh` daily at 02:00. Configure it with `docker/backup.env` as described in step 2; no further setup is needed.

If you prefer a Linux-native systemd timer instead (e.g., on a host without Docker for backups, or to run the host-side `scripts/backup.sh`), do the following:

```bash
# 1. Test a manual backup
export RESTIC_PASSWORD=<choose-a-strong-passphrase>
export PAPERLESS_DBUSER=paperless
export PAPERLESS_DBPASS=<same-as-docker/.env>
bash scripts/backup.sh

# 2. Create the env file the systemd unit reads
cat > ~/aktenraum/.backup.env <<EOF
RESTIC_PASSWORD=${RESTIC_PASSWORD}
PAPERLESS_DBUSER=${PAPERLESS_DBUSER}
PAPERLESS_DBPASS=${PAPERLESS_DBPASS}
EOF
chmod 600 ~/aktenraum/.backup.env

# 3. Substitute the repo path placeholder, then install the unit + timer
REPO_PATH="$(pwd)"
sed "s|__REPO_PATH__|${REPO_PATH}|" docker/systemd/aktenraum-backup.service \
  | sudo tee /etc/systemd/system/aktenraum-backup@${USER}.service > /dev/null
sudo cp docker/systemd/aktenraum-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aktenraum-backup.timer
systemctl status aktenraum-backup.timer
```

Store your `RESTIC_PASSWORD` securely (password manager). **You cannot restore backups without it.**

### 8. Test ingestion

Drop a PDF into `~/aktenraum/consume/`. Within a minute it should appear in Paperless with OCR text. Within 30–60 seconds of that, the auto-tagger should add `ai_*` custom fields and the `ai-pending` tag.

---

## TODO: HTTPS / Tailscale

To expose Paperless securely beyond localhost, add a reverse proxy (nginx, Caddy) or join the host to your Tailscale network. This is intentionally deferred from v1.
