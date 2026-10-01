# Runbook: Rotating API keys

All secrets live in one file, `docker/.env`, loaded by every service. After editing it, recreate the affected containers with `docker compose up -d <service…>` — `docker compose restart` does **not** re-read env files. Commands below run from the repository root with `DC="docker compose --project-directory docker"`.

---

## Rotate the Paperless secret key

The Paperless secret key is used for session signing and CSRF tokens. Rotating it logs out all active Paperless sessions but does not affect document data.

1. Generate a new key:
   ```bash
   openssl rand -hex 32
   ```
2. Replace `PAPERLESS_SECRET_KEY` in `docker/.env`.
3. Recreate Paperless:
   ```bash
   $DC up -d paperless
   ```
4. Existing Paperless browser sessions are invalidated. Log in again.

---

## Rotate the Paperless API token

Both `auto-tagger` and `aktenraum-api` use the same `PAPERLESS_API_TOKEN`.

1. In the Paperless UI: **Settings → API Tokens → Delete** the existing token, then **Add Token**. Or mint one via `POST http://localhost:8000/api/token/` with the admin credentials.
2. Set `PAPERLESS_API_TOKEN` in `docker/.env` to the new token.
3. Recreate both Node services:
   ```bash
   $DC up -d auto-tagger aktenraum-api
   ```

`task recover` (`scripts/fix-token.sh`) does steps 1–3 in one go: it mints a token with the admin credentials from `docker/.env`, writes it into `docker/.env` and recreates both services.

---

## Rotate the Anthropic API key

1. In the Anthropic Console, create a new API key and disable the old one.
2. Update `ANTHROPIC_API_KEY` in `docker/.env`.
3. Recreate both services that call the LLM:
   ```bash
   $DC up -d auto-tagger aktenraum-api
   ```
4. Confirm it is working:
   ```bash
   $DC logs -f auto-tagger
   # Upload a test document and watch for extraction logs
   ```

---

## Rotate the webhook secret

`WEBHOOK_SECRET` gates the auto-tagger's `/trigger/*` endpoints, Paperless's `post_consume` call and the api's internal `/api/settings/active-*` endpoints. Every service reads it from `docker/.env`, so one edit keeps them consistent.

1. Generate a new value: `openssl rand -base64 32`
2. Replace `WEBHOOK_SECRET` in `docker/.env`.
3. Recreate everything that uses it:
   ```bash
   $DC up -d paperless auto-tagger aktenraum-api
   ```

---

## Rotate the JWT signing key

1. Generate a new value: `openssl rand -base64 32`
2. Replace `JWT_SECRET` in `docker/.env`.
3. `$DC up -d aktenraum-api`. Every SPA session is invalidated; users log in again.

---

## Rotate the database password

`PAPERLESS_DBPASS` is used by postgres, Paperless, aktenraum-api (`DATABASE_URL` is built from it in `docker-compose.yml`) and the backup container. The postgres image only applies `POSTGRES_PASSWORD` on a fresh volume, so change the live password with SQL.

1. Generate a new password and apply it to the running postgres instance:
   ```bash
   $DC exec postgres psql -U paperless -c "ALTER USER paperless PASSWORD 'new-password';"
   ```
2. Update `PAPERLESS_DBPASS` in `docker/.env` to the same value.
3. Recreate the services that connect to postgres:
   ```bash
   $DC up -d paperless aktenraum-api backup
   ```
4. If you use the optional host-side systemd backup, also update `PAPERLESS_DBPASS` in `~/aktenraum/.backup.env`.

---

## Rotate the restic repository passphrase

Run inside the backup container (it already has the current `RESTIC_PASSWORD` from `docker/.env`):

```bash
$DC exec -it -e RESTIC_REPOSITORY=/repo backup restic key add     # prompts for the new passphrase
$DC exec -e RESTIC_REPOSITORY=/repo backup restic key list        # confirm the new key is present
$DC exec -e RESTIC_REPOSITORY=/repo backup restic key remove <old-key-id>
```

Then set `RESTIC_PASSWORD` in `docker/.env` to the new passphrase and `$DC up -d backup`. If you use the optional host-side systemd backup, also update `~/aktenraum/.backup.env`. Verify with `task backup:verify` or a manual run (`$DC exec backup /usr/local/bin/entrypoint.sh`).
