# Runbook: Rotating API keys

## Rotate the Paperless secret key

The Paperless secret key is used for session signing and CSRF tokens. Rotating it logs out all active sessions but does not affect document data.

1. Generate a new key:
   ```bash
   openssl rand -hex 32
   ```
2. Open `docker/.env` and replace `PAPERLESS_SECRET_KEY` with the new value.
3. Restart Paperless:
   ```bash
   cd docker && docker compose restart paperless
   ```
4. All existing browser sessions will be invalidated. Log in again.

---

## Rotate the Paperless API token (auto-tagger)

1. In the Paperless UI: **Settings → API Tokens → Delete** the existing token, then **Add Token**.
2. Copy the new token.
3. Open `docker/auto-tagger.env` and update `PAPERLESS_API_TOKEN`.
4. Restart the auto-tagger:
   ```bash
   cd docker && docker compose restart auto-tagger
   ```

---

## Rotate the Anthropic API key

1. In the Anthropic Console, create a new API key and disable the old one.
2. Open `docker/auto-tagger.env` and update `ANTHROPIC_API_KEY`.
3. Restart the auto-tagger:
   ```bash
   cd docker && docker compose restart auto-tagger
   ```
4. Confirm it is working:
   ```bash
   docker compose logs -f auto-tagger
   # Drop a test document and watch for extraction logs
   ```

---

## Rotate the database password

Rotating the postgres password requires updating both postgres itself and the Paperless configuration.

1. Open `docker/.env`, generate a new password, and update `PAPERLESS_DBPASS`.
2. Apply the change to the running postgres instance:
   ```bash
   docker compose exec postgres psql -U paperless -c "ALTER USER paperless PASSWORD 'new-password';"
   ```
3. Restart Paperless to pick up the new password:
   ```bash
   docker compose restart paperless
   ```
4. Update `scripts/backup.sh` env or your backup env file if `PAPERLESS_DBPASS` is set there.

---

## Rotate the restic repository passphrase

```bash
export RESTIC_REPOSITORY=~/aktenraum/backup/restic-repo
export RESTIC_PASSWORD=<current-passphrase>

restic key add  # prompts for new passphrase
restic key list  # confirm new key is present
restic key remove <old-key-id>  # remove old key
```

Update your backup env file (`~/aktenraum/.backup.env`) with the new passphrase. Verify the next backup run succeeds.
