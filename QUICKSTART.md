# Aktenraum — Quick Start

## What is this?

Aktenraum is your personal document manager. You upload PDFs; the AI reads them, figures out what they are (invoices, contracts, payslips…), tags them, and makes them searchable in German.

It runs as 10 background programs on your computer, managed by Docker.

---

## Where does your data live?

**Everything is stored in `D:\aktenraum\`** — a normal Windows folder you can open in File Explorer.

| What | Where |
|---|---|
| Your uploaded documents (PDFs) | `D:\aktenraum\media\` |
| Database (AI metadata, tags, correspondents) | `D:\aktenraum\pgdata\` |
| Daily backups | `D:\aktenraum\backup\` |

Your data is yours. Uninstalling Docker doesn't touch this folder.

---

## What happens when you stop Docker?

**Nothing is deleted.**

`task stop` is like closing Excel — the spreadsheet isn't gone, the program just isn't running. All your files in `D:\aktenraum\` stay exactly where they are.

`task start` turns everything back on and picks up exactly where you left off.

> **Why did data disappear twice before?**
>
> The programs were writing data *inside Docker's own internal storage* instead of to
> your `D:\aktenraum\` folder. Docker's internal storage can be wiped when Docker
> Desktop resets or reinstalls. That bug is now fixed — data goes straight to `D:\`.

---

## The only 3 commands you need

Open a terminal in `D:\Development\document-organizer` and run:

```
task start      ← turn aktenraum on
task stop       ← turn it off (data is safe)
task status     ← check if everything is running
```

Then open **http://localhost:8080** in your browser.

---

## First-time setup (run once, ever)

```
task setup
```

This does everything automatically:
1. Generates all passwords and secrets
2. Starts all 10 services
3. Creates the AI custom fields in Paperless
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

This mints a new token and reconnects all services. Takes about 30 seconds.

### My documents are gone / blank database

If the database was wiped (shouldn't happen anymore, but just in case):

```
task recover
```

Then re-upload your documents via the Upload page in the app. Documents aren't stored only in the database — the backup also keeps copies.

To restore from a backup snapshot:

```
task backup:snapshots     ← see what snapshots exist
```

Then follow `docs/runbooks/restore.md`.

---

## Complete wipe (start 100% fresh)

```
task destroy
```

This stops everything and deletes **all** data in `D:\aktenraum\` including all documents and backups. There is no undo. It will ask you to type `DELETE` to confirm.

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
| Make a manual backup | `task backup:run` |
| List backup history | `task backup:snapshots` |
| Rebuild after code changes | `task build` |
| Rebuild frontend only | `task build:fe` |
| Rebuild backend only | `task build:be` |
| Wipe everything | `task destroy` |
