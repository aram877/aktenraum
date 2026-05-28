# Audit remediation — manual test checklist

Run these on the machine that holds the real data (the one with your
populated Paperless + `aktenraum` databases and an existing restic repo).
This file is updated with every remediation commit — each section maps to
one change, with the exact commands and the pass criteria.

**Before testing:**
```bash
git pull                     # get the latest commits
cd docker && docker compose up -d   # ensure the stack is running
```

Mark each item: ⬜ not tested · ✅ passed · ❌ failed (add notes).

> Tracks the plan in [`docs/plans/audit-remediation.md`](../plans/audit-remediation.md).

---

## Phase 0.1 — Scheduled backup cron now fires
**Commit:** `9808628` · **Files:** `docker/backup/crontab`
**What changed:** removed the invalid `root` user-column from the crontab
(BusyBox crond was execing a binary named `root` → silent nightly failure);
routed job output to `docker compose logs backup` so failures aren't silent.

**Test:**
```bash
cd docker
docker compose up -d --build backup          # bake in the fixed crontab

# 1. crontab is now valid (NO `root` column)
docker compose exec backup crontab -l
#    expect: 0 2 * * * /usr/local/bin/entrypoint.sh >> /proc/1/fd/1 2>&1

# 2. tail logs in one terminal
docker compose logs -f backup

# 3. in another terminal, temporarily run every minute to exercise the
#    SCHEDULED path now (also proves cron passes env vars to the job)
docker compose exec backup sh -c \
  'printf "* * * * * /usr/local/bin/entrypoint.sh >> /proc/1/fd/1 2>&1\n" | crontab -'

#    wait ~70s — entrypoint log lines should appear in the logs window

# 4. reset to the real 02:00 schedule
docker compose up -d --build backup
```
**Pass:** step 3 produces visible entrypoint logs within ~70s (previously:
total silence).
**Status:** ⬜ not tested

---

## Phase 0.2 — Backup now captures the `aktenraum` DB + restore actually works
**Commit:** _(see git log: "fix(backup): also dump aktenraum DB + correct restore runbook")_
**Files:** `docker/backup/entrypoint.sh`, `scripts/backup.sh`,
`docs/runbooks/restore.md`
**What changed:** the backup dumped only the `paperless` DB — the `aktenraum`
DB (SPA users + per-type auto-approve rules) was never captured, and the
restore runbook's filesystem `--include` paths matched nothing in
container snapshots. Added an `aktenraum.dump` stream (tag
`postgres-aktenraum`) and rewrote the restore runbook (correct `/backup/*`
paths + staging-dir move + both-DB restore + SPA verification).

**Test A — backup captures both DBs:**
```bash
cd docker
docker compose up -d                         # stack must be up (needs postgres)
docker compose up -d --build backup          # rebuild backup with new entrypoint

# run a backup manually
MSYS_NO_PATHCONV=1 docker compose exec backup //usr/local/bin/entrypoint.sh

# both DB dumps should now exist
docker compose exec backup restic -r /repo snapshots --tag postgres            # paperless.dump
docker compose exec backup restic -r /repo snapshots --tag postgres-aktenraum  # aktenraum.dump (NEW)

# the aktenraum dump should contain real SQL
docker compose exec backup sh -c \
  'restic -r /repo dump --tag postgres-aktenraum latest aktenraum.dump | head -30'
```
**Pass A:** a snapshot exists under tag `postgres-aktenraum` and its dump
shows SQL (`CREATE TABLE` / `COPY` for `users`, `auto_approve_rules`).
**Status:** ⬜ not tested

**Test B — full restore rehearsal (the real DR gate; optional but recommended):**
Follow [`docs/runbooks/restore.md`](../runbooks/restore.md) end-to-end into a
**throwaway** environment (a scratch `AKTENRAUM_DATA_DIR` + fresh DB volume —
do NOT restore over your live data). Then confirm the verification checklist
at the bottom of that runbook:
- [ ] Paperless UI loads with the expected document count
- [ ] aktenraum SPA login works with your original credentials (proves the
      `aktenraum` DB restored)
- [ ] `/settings → Auto-Genehmigung` shows your configured rules, not defaults
**Pass B:** all three boxes tick.
**Status:** ⬜ not tested

---

## How this file is maintained

Every remediation commit appends (or updates) a section here with its test
steps before the work is considered shippable. The "Status" lines are yours
to fill in on the data machine — flip ⬜ → ✅/❌ and note anything that broke.
