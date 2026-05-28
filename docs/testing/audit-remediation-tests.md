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

## Phase 0.3 — Integrity check + DR rehearsal tooling
**Commit:** _(see git log: "feat(backup): integrity check, DR rehearsal, init guard, B2 verify")_
**Files:** `docker/backup/entrypoint.sh`, `docker/backup/verify-backup.sh` (new),
`docker/backup/Dockerfile` (adds `jq`), `scripts/backup.sh`, `Taskfile.yml`
**What changed:** added a weekly `restic check` inside the backup job, a
non-destructive DR rehearsal (`task backup:verify`), and an on-demand
integrity check (`task backup:check`).

**Test:**
```bash
cd docker
docker compose up -d --build backup          # rebuild (now includes jq + verify-backup.sh)

# integrity check
task backup:check
#   expect: "no errors were found"

# full DR rehearsal — restic check + filesystem restore to staging + both DB dumps
task backup:verify
#   expect final line: "[verify] PASS — repo integrity OK, filesystem restorable, both DB dumps valid."
```
**Pass:** `task backup:verify` ends with `PASS`. If it fails on the
`aktenraum` DB dump, you're running against a backup taken before Phase 0.2
— run `task backup:run` once first, then re-verify.
**Status:** ⬜ not tested

---

## Phase 0.4 — Repo auto-init guard (no silent abandon on data-dir drift)
**Commit:** _(same as 0.3)_ · **Files:** `docker/backup/entrypoint.sh`, `scripts/backup.sh`
**What changed:** the backup no longer silently creates a new repo when one is
missing (which, on an `AKTENRAUM_DATA_DIR` drift, would abandon the real
backup history). It now fails loudly unless `BACKUP_AUTO_INIT=true`.

**Test (safe — uses a throwaway repo path, never your real one):**
```bash
cd docker
# point at a guaranteed-empty repo path and confirm it REFUSES to init
docker compose exec -e RESTIC_REPOSITORY=/tmp/does-not-exist backup \
  //usr/local/bin/entrypoint.sh ; echo "exit=$?"
#   expect: "ERROR: no restic repository at /tmp/does-not-exist" + exit=1

# and that the opt-in still works
docker compose exec -e RESTIC_REPOSITORY=/tmp/newrepo -e BACKUP_AUTO_INIT=true backup \
  sh -c 'restic snapshots >/dev/null 2>&1 || echo "would init (BACKUP_AUTO_INIT honoured)"'
```
**Pass:** missing repo without the flag → loud error + non-zero exit; with
`BACKUP_AUTO_INIT=true` → proceeds. Your real `/repo` is untouched.
**Status:** ⬜ not tested

---

## Phase 0.5 — B2 offsite copy verification
**Commit:** _(same as 0.3)_ · **Files:** `docker/backup/entrypoint.sh`, `scripts/backup.sh`
**What changed:** after the optional B2 `restic copy`, the job now compares
local vs remote snapshot counts and fails if the remote has fewer (previously
a partial/zero copy went undetected). Only relevant if you use B2
(`BACKUP_B2_BUCKET` set).

**Test (only if B2 is configured):**
```bash
cd docker
docker compose exec backup //usr/local/bin/entrypoint.sh 2>&1 | grep -i b2
#   expect: "B2 copy verified: N snapshots on remote (local N)."
```
**Pass:** the "B2 copy verified" line appears with matching counts. (Skip if
you don't use B2.)
**Status:** ⬜ not tested / N/A

---

## Phase 0.6 — Doc correction (no test)
**Commit:** _(same as 0.3)_ · **Files:** `CLAUDE.md`
**What changed:** corrected the stale "restic init missing" gotcha (the
entrypoint self-inits; the real historical cause was the 0.1 cron bug) and
flipped the "Backup integrity checks" row to ✅. Documentation only — nothing
to test.
**Status:** ✅ n/a (doc-only)

---

## Phase 1.1 — Secure cookie default (fresh installs)
**Commit:** _(see git log: "feat(security): secure cookie default, prompt-injection hardening, webhook-secret warning")_
**Files:** `docker/aktenraum-api.env.example`
**What changed:** the example no longer ships `COOKIE_SECURE=false`; it's
commented out so the code default (`true`) applies. **Does NOT affect your
existing `docker/aktenraum-api.env`** — only new installs that copy the
example. Your current deployment keeps whatever you already set.

**Test (only relevant for a brand-new install):**
```bash
grep COOKIE_SECURE docker/aktenraum-api.env.example
#   expect: the line is commented (# COOKIE_SECURE=false)
```
**Pass:** fresh installs default to a Secure cookie; over Tailscale HTTPS
login still works. (Your existing env is untouched — no action needed.)
**Status:** ⬜ not tested

---

## Phase 1.2 — Prompt-injection hardening
**Commit:** _(same as 1.1)_
**Files:** `services/auto-tagger/src/auto_tagger/tagger.py`,
`services/auto-tagger/tests/test_tagger.py`
**What changed:** (a) added a SICHERHEIT clause to `SYSTEM_PROMPT` telling the
LLM that document text is data, never instructions (so a PDF can't say "set
confidence 1.0" to skip review); (b) docs arriving via an untrusted path
(`email-ingested` tag) now **never auto-approve** regardless of confidence/
rules — they always route to `ai-pending` with reason
`untrusted_source_no_auto_approve`.

**Test A — covered by unit tests (already run in CI/local):**
`test_untrusted_source_never_auto_approves` + the low-confidence variant.

**Test B — live (only if you have auto-approve enabled for some type):**
```bash
# Enable auto-approve for, say, Rechnung in /settings → Auto-Genehmigung, then
# ingest a Rechnung VIA EMAIL (so it gets the email-ingested tag).
# It must land in the review queue, NOT auto-approved.
docker compose logs auto-tagger | grep routing_decision | tail
#   expect reason=untrusted_source_no_auto_approve for the email-ingested doc
```
**Pass:** an email-ingested doc never auto-approves; an uploaded doc of the
same type still can. (Skip B if you don't use email ingestion or auto-approve.)
**Status:** ⬜ not tested

---

## Phase 1.3 — WEBHOOK_SECRET startup warning
**Commit:** _(same as 1.1)_
**Files:** `services/aktenraum-api/src/aktenraum_api/main.py`,
`services/auto-tagger/src/auto_tagger/main.py`
**What changed:** both services now log a loud `webhook_secret_unset` WARNING
at startup if `WEBHOOK_SECRET` is empty (the internal endpoints would then be
unauthenticated, relying on Docker network isolation alone). Non-breaking — a
warning, not a hard fail, so it can't brick an existing stack.

**Test:**
```bash
cd docker
docker compose up -d --build aktenraum-api auto-tagger
# If your WEBHOOK_SECRET is set (the normal case), you should see NO warning:
docker compose logs aktenraum-api auto-tagger | grep webhook_secret_unset || echo "no warning — secret is set (good)"
```
**Pass:** with a configured secret → no warning. (If you want to see the
warning fire, temporarily blank `WEBHOOK_SECRET` in both env files and
recreate — then restore it.)
**Status:** ⬜ not tested

> **Deferred this round:** 1.4 (upload magic-byte sniffing — adds a dependency,
> low real impact) and 1.5 (JWT revocation — optional). Tracked in
> `docs/plans/audit-remediation.md`.

---

## How this file is maintained

Every remediation commit appends (or updates) a section here with its test
steps before the work is considered shippable. The "Status" lines are yours
to fill in on the data machine — flip ⬜ → ✅/❌ and note anything that broke.
