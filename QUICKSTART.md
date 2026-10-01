# Aktenraum — Quick Start

## What is this?

Aktenraum is your personal document manager. You upload PDFs; the AI reads them, figures out what they are (invoices, contracts, payslips…), tags them, and makes them searchable in German.

It runs as 10 background programs on your computer, managed by Docker.

---

## Where does your data live?

**Everything is stored in one folder: the `AKTENRAUM_DATA_DIR` set in `docker/.env`** — a normal folder you can open in File Explorer or Finder (for example `D:\aktenraum\` on Windows, `/Users/you/aktenraum/` on macOS).

| What | Where (inside that folder) |
|---|---|
| Your uploaded documents (PDFs) | `media/` |
| Database (AI metadata, tags, correspondents) | `pgdata/` |
| Search index (for Ask AI) | `qdrant/` |
| Daily backups | `backup/` |

Your data is yours. Uninstalling Docker doesn't touch this folder.

---

## What happens when you stop Docker?

**Nothing is deleted.**

`task stop` is like closing Excel — the spreadsheet isn't gone, the program just isn't running. All your files in your data folder stay exactly where they are.

`task start` turns everything back on and picks up exactly where you left off.

> **Why did data disappear twice before?**
>
> The programs were writing data *inside Docker's own internal storage* instead of to
> your data folder. Docker's internal storage can be wiped when Docker
> Desktop resets or reinstalls. That bug is now fixed — data goes straight to the folder
> named by `AKTENRAUM_DATA_DIR`, and the stack refuses to start if it is not set.

---

## The only 3 commands you need

Open a terminal in the aktenraum repository folder and run:

```
task start      ← turn aktenraum on
task stop       ← turn it off (data is safe)
task status     ← check if everything is running
```

Then open **http://localhost:8080** in your browser.

---

## First-time setup (run once, ever)

Copy `docker/.env.example` to `docker/.env` and set `AKTENRAUM_DATA_DIR` to an absolute path (e.g. `D:/aktenraum` or `/Users/you/aktenraum`). Then:

```
task setup
```

This does everything automatically:
1. Creates the data folders and generates all passwords and secrets in `docker/.env`
2. Starts all 10 services
3. Mints the Paperless API token and creates the AI custom fields and tags in Paperless
4. Initialises the backup system
5. Takes the first backup

Your login password is printed at the end — **write it down**, it won't be shown again.

---

## Recovery commands

### "API rejected" / 401 errors after a restart

This means the internal API token got out of sync (usually after a database wipe). Run:

```
task recover
```

This mints a new token and restarts the auto-tagger and aktenraum-api. Takes about 30 seconds.

### My documents are gone / blank database

If the database was wiped (shouldn't happen anymore, but just in case):

```
task recover
```

Then re-upload your documents via the Upload page in the app. Documents aren't stored only in the database — the backup also keeps copies.

To restore from a backup snapshot:

```
docker compose --project-directory docker exec -e RESTIC_REPOSITORY=/repo backup restic snapshots --tag aktenraum
```

Then follow `docs/runbooks/restore.md`.

---

## Complete wipe (start 100% fresh)

```
task destroy
```

This stops everything and deletes **all** data in your `AKTENRAUM_DATA_DIR` folder, including all documents and backups. There is no undo. It will ask you to type `DELETE` to confirm.

After a destroy, run `task setup` to start over.

---

## Why are there so many other `task` commands?

The rest of the tasks are for development: rebuilding code, running tests, debugging. You don't need them to use the app. `task --list` shows everything.

---

## Quick reference card

| Situation | Command |
|---|---|
| Start aktenraum | `task start` |
| Stop aktenraum | `task stop` |
| Is it running? | `task status` |
| First-time setup | `task setup` |
| Fix 401 / API errors | `task recover` |
| Make a manual backup | `docker compose --project-directory docker exec backup /usr/local/bin/entrypoint.sh` (Git Bash: `MSYS_NO_PATHCONV=1` and `//usr/local/bin/entrypoint.sh`) |
| List backup history | `docker compose --project-directory docker exec -e RESTIC_REPOSITORY=/repo backup restic snapshots --tag aktenraum` |
| Check a backup really restores | `task backup:verify` |
| Rebuild after code changes | `task build` |
| Wipe everything | `task destroy` |
