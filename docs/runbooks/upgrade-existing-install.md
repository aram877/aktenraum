# Upgrade an existing install

Brings a machine that already runs aktenraum up to the current `main`.
Safe to run on every host and safe to re-run: every step is idempotent, and
your documents, databases and backups are never deleted.

**For a Claude session on that machine:** run the steps in order from the
repository root. After each step, compare the output with **Expected**. If it
does not match, follow **If it fails** for that step; if that doesn't cover
it, stop and report the exact output to the user instead of improvising.
Never delete anything under `AKTENRAUM_DATA_DIR`, never overwrite
`docker/.env` wholesale, and never run `task destroy`.

All commands are bash. On Windows use **Git Bash** (not PowerShell or cmd).

---

## 1. Get the latest code

```bash
git pull
```

**Expected:** `Already up to date.` or a list of updated files.
**If it fails** with local changes: run `git status`, show it to the user, stop.

## 2. Keep a copy of the current settings

```bash
cp docker/.env "docker/.env.before-upgrade-$(date +%Y%m%d-%H%M%S)"
```

**Expected:** no output. `docker/.env` is never touched by git, so this copy is
the only rollback for step 3.

## 3. Fill in new or missing secrets

```bash
bash scripts/bootstrap-secrets.sh
```

**Expected:** either `All secrets already populated` or a list of generated /
carried-over values (e.g. `Qdrant API key: generated ✓`,
`RESTIC_PASSWORD ← backup.env`). Existing values are never changed.

**If it fails** with `RESTIC_PASSWORD is missing … a restic repository already
exists`: the backup passphrase is not in `docker/.env` or in any old
`docker/*.env` file. Do not invent one — a new password cannot open the
existing backups. Ask the user for the original passphrase and add it as a
line `RESTIC_PASSWORD=<passphrase>` to `docker/.env`, then re-run this step.

## 4. Check the required values

```bash
for key in AKTENRAUM_DATA_DIR WEBHOOK_SECRET QDRANT_API_KEY RESTIC_PASSWORD PAPERLESS_API_TOKEN; do
  if grep -q "^${key}=." docker/.env; then echo "ok      ${key}"; else echo "MISSING ${key}"; fi
done
```

**Expected:** five `ok` lines.
**If it fails:**
- `MISSING AKTENRAUM_DATA_DIR` → ask the user where the data lives (e.g.
  `D:/aktenraum` on Windows, `/Users/<name>/aktenraum` on macOS) and add
  `AKTENRAUM_DATA_DIR=<path>`. Never guess: a wrong path starts an empty database.
- `MISSING PAPERLESS_API_TOKEN` → it is fixed in step 7 (`task recover`); continue.
- anything else → re-run step 3.

## 5. Give the Qdrant folder to the Qdrant user

Qdrant runs as uid 1000 since 2026-10-01. Folders created by the old (root)
Qdrant are not writable for it, and Qdrant then crashes with
`Can't init WAL … Permission denied`. Compose now runs this automatically on
every start (the one-shot `qdrant-init` service); running it by hand here is
harmless and covers hosts that haven't pulled that change yet:

```bash
DATA_DIR="$(grep '^AKTENRAUM_DATA_DIR=' docker/.env | tail -1 | cut -d= -f2-)"
mkdir -p "${DATA_DIR}/qdrant"
MSYS_NO_PATHCONV=1 docker run --rm -v "${DATA_DIR}/qdrant:/q" alpine:3.22 chown -R 1000:1000 /q
```

**Expected:** no output. (`MSYS_NO_PATHCONV=1` only matters in Git Bash and is
ignored elsewhere.)

## 6. Rebuild and start everything

```bash
docker compose --project-directory docker up -d --build --remove-orphans
```

(Equivalent to `task build`.) Takes a few minutes the first time.

**Expected:** ends with every container `Started` / `Running`, no error.
`--remove-orphans` also removes containers of services that no longer exist
(e.g. an old `docker-aktenraum-api-node-1`); that is intended.

**If it fails** with `dependency failed to start: container docker-qdrant-1 is
unhealthy`: run `docker logs docker-qdrant-1 2>&1 | tail -20`. A
`Permission denied` there means step 5 did not take effect — repeat step 5,
then this step. Anything else: report the log.

## 7. Wait until everything is healthy

```bash
for i in $(seq 1 30); do
  waiting="$(docker compose --project-directory docker ps --format '{{.Service}} {{.Status}}' | grep -E 'starting|unhealthy' || true)"
  [ -z "${waiting}" ] && break
  sleep 10
done
docker compose --project-directory docker ps --format '{{.Service}}: {{.Status}}'
```

**Expected:** every service `Up …`; all of them say `(healthy)` except
`gotenberg` and `tika` (no healthcheck). `backup` may still say
`health: starting` or `unhealthy` until step 8 has run — that is fine here.

**If it fails:** a service that is `unhealthy` (other than backup) or
`Restarting` → `docker logs docker-<service>-1 2>&1 | tail -30` and report it.
If the logs show `401` / `Invalid token` against Paperless, run
`task recover` and repeat this step.

## 8. Take a backup now and prove it restores

```bash
MSYS_NO_PATHCONV=1 docker compose --project-directory docker exec backup //usr/local/bin/entrypoint.sh
task backup:verify
```

**Expected:** the backup ends with `Backup complete.`; the verify output
contains `original documents` and ends with
`PASS — repo integrity OK, filesystem restorable, both DB dumps valid.`

**If it fails:**
- `RESTIC_PASSWORD is required` → step 4 was skipped; fix it, redo step 6.
- `wrong password or no key found` → the passphrase in `docker/.env` is not the
  repository's. Check `docker/.env.before-upgrade-*` and the old
  `docker/backup.env` for the right one; ask the user if neither works.
- verify says `0 original documents` → report it; do not continue.

## 9. Log in again

Every session was invalidated by the upgrade (sessions are now bound to the
password). Tell the user to reload http://localhost:8080 and log in. The
login, if they need it:

```bash
grep '^BOOTSTRAP_' docker/.env
```

`BOOTSTRAP_USERNAME` / `BOOTSTRAP_PASSWORD` are the original login; if the user
changed the password in the app later, the file still shows the old one.

## 10. Report

Tell the user, in plain words: which steps changed something, that the backup
verify passed (quote the `original documents` line), and anything you had to
skip. Do **not** delete the old `docker/{auto-tagger,aktenraum-api,backup}.env`
files yourself — mention that they can be removed once the user is happy,
because they still contain old secrets.
