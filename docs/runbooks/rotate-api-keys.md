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

## Rotate a service credential

The three `SVC_TOKEN_*` values authenticate the internal calls (ADR-010 step 5): `SVC_TOKEN_PAPERLESS_HOOK` (Paperless `post_consume` → worker), `SVC_TOKEN_API` (api → worker triggers and `/processing`), `SVC_TOKEN_WORKER` (worker → api internal routes). Rotate one when it may have leaked; every service reads them from `docker/.env`, so one edit keeps both ends consistent.

1. Empty the value in `docker/.env` (e.g. `SVC_TOKEN_API=`) and run `bash scripts/bootstrap-secrets.sh` — it generates a new `akt_svc_…` value and changes nothing else.
2. Recreate the services that hold it (`restart` does not re-read `.env`):
   ```bash
   $DC up -d paperless auto-tagger aktenraum-api
   ```
3. Check: `$DC logs --since 2m auto-tagger aktenraum-api | grep service_token_` prints nothing.

During the recreate a post-consume hook or trigger may hit a mismatched pair and get 401; the 30 s poller picks the document up anyway. `WEBHOOK_SECRET` is retired and needs no rotation.

---

## Revoke a leaked personal access token

Personal access tokens (`akt_pat_…`, ADR-010 step 6) belong to one member and are never stored in readable form, so there is nothing to rotate — revoke the token and create a new one.

1. The member opens `/settings → Konto → Zugriffstokens`, finds the token by its name and prefix (`akt_pat_` + 4 characters) and clicks **Widerrufen** twice. The next request with it gets 401. The list shows when and from which address the token was last used (updated at most once a minute) — compare it with where the script runs.
2. Create a replacement with the same or narrower scopes and put the new value into the script.
3. If the member can't sign in, revoke all of their tokens from the host:
   ```bash
   $DC exec postgres psql -U paperless -d aktenraum -c \
     "UPDATE personal_access_tokens SET revoked_at = now(), revoked_reason = 'user' WHERE revoked_at IS NULL AND member_id = (SELECT m.id FROM members m JOIN users u ON u.id = m.user_id WHERE u.username = '<name>');"
   ```
4. What it did: `credential_audit` has `token_created` / `token_revoked` / `token_rejected_expired`; repeated bad tokens from one address show up as `pat_rejected` / `pat_throttled` in `$DC logs aktenraum-api`.

A token can't change credentials, create tokens or run step-up actions (empty the trash, remove members, change models), so a leak never becomes an account takeover; it grants its scopes until revoked or expired.

---

## Sign everyone out

There is no signing key any more (auth-server-sessions, 2026-11-20): sessions live in the `sessions` table and the cookie holds only a random token. `JWT_SECRET` is unused. To end every SPA session at once, revoke them in the database:

```bash
$DC exec postgres psql -U paperless -d aktenraum -c   "UPDATE sessions SET revoked_at = now(), revoked_reason = 'user' WHERE revoked_at IS NULL;"
```

Users log in again; open live streams end within 3 s. One member's own devices: `/settings → Konto → Geräte`.

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
