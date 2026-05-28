# Audit remediation plan

The durable, prioritized plan for fixing the findings from the 2026-05-28 full-app audit (four read-only dimension reviews + one adversarially-verified backup/restore workflow). Findings are grouped into phases by **blast radius first, effort second**: a phase is "done" only when its items are fixed, tested, and — where they touch a documented behaviour — the docs are corrected in the same commit (per the binding documentation cadence in `CLAUDE.md`).

**Status**: Phase 0 (disaster recovery) implemented and pushed — awaiting end-to-end verification on the data machine (see `docs/testing/audit-remediation-tests.md`). Phases 1–5 not started. Phases 0–2 are the load-bearing ones; 3–5 are hardening and tech-debt.

> **Severity legend**: 🔴 CRITICAL (data loss / security / silently broken) · 🟠 HIGH · 🟡 MEDIUM · ⚪ LOW.
> Severities reflect the **adversarially-verified** outcome — where the verification workflow refuted or re-rated a first-pass finding, the corrected rating is used and the correction is noted.

---

## How to execute this

- **Each phase = one OpenSpec change** (`openspec new change`), per the repo convention for non-trivial work. Phase 0 is small enough to be a single change; Phases 3–4 can be split if they grow.
- **Commit discipline (binding)**: never commit before `task test` passes; never commit a bug fix before the user confirms it's fixed. Disaster-recovery items (Phase 0) additionally require an **end-to-end restore rehearsal** before they count as done — a backup you have not restored is not a backup.
- **Order within a phase is smallest-first** where dependencies allow, so each commit is independently shippable.

---

## Phase 0 — Disaster recovery is broken (🔴 do this first)

The verification workflow proved recovery does **not** work end-to-end today. Two independent CRITICALs, each sufficient on its own. Empirically reproduced on `alpine:3.20` (BusyBox 1.36.1).

### 0.1 🔴 Scheduled backups never run — crontab format mismatch
- **Broken**: `docker/backup/crontab:1` is `0 2 * * * root /usr/local/bin/entrypoint.sh` — 6-field system-cron format with a `root` user column. `docker/backup/Dockerfile:13` installs it as a *user* crontab (`crontab <file>`), so BusyBox crond treats `root` as the command → `sh: root: not found`, silently, every night.
- **Correction to first-pass audit**: the original audit blamed BusyBox crond stripping env vars. That was **empirically refuted** — crond (PID 1) inherits `env_file` vars and passes them to jobs. The sole cause is the crontab format.
- **Fix**: `docker/backup/crontab` → `0 2 * * * /usr/local/bin/entrypoint.sh` (drop `root`). Rebuild `task build:be`.
- **Effort**: 1 line. **Verify**: install a temporary `* * * * *` entry, confirm a snapshot lands within ~70s, then revert.

### 0.2 🔴 Restore recovers nothing useful — path mismatch + missing DB
- **Broken (filesystem)**: container backs up `/backup/{data,media,export}` (`entrypoint.sh:25-30`) but `docs/runbooks/restore.md:58-63` restores `--include /home/<user>/aktenraum/...`. Those prefixes match nothing in container snapshots → `restic restore` exits 0 having restored **zero files**. (The runbook includes only fit the non-default host script `scripts/backup.sh:41-43`.)
- **Broken (DB)**: `entrypoint.sh:36` + `scripts/backup.sh:52` dump only `paperless`. The `aktenraum` DB (SPA `users`, `auto_approve_rules`) is **never dumped** and `restore.md:88-92` never restores it → after a "successful" restore, all SPA accounts + auto-approve config are gone.
- **Fix (DB backup)**: add to both `entrypoint.sh` and `scripts/backup.sh`, after the paperless dump:
  ```
  pg_dump -h postgres -U paperless aktenraum | restic backup --stdin --stdin-filename aktenraum.dump --tag aktenraum
  ```
- **Fix (restore)**: in `restore.md`, change includes to `/backup/{data,media,export}`; add `restic dump <snap> aktenraum.dump | psql -U paperless aktenraum`; add a `restic ls latest` confirmation step.
- **Effort**: ~½ day incl. runbook rewrite.

### 0.3 🟡 No integrity check, no restore rehearsal, manual-only restore
- **Broken**: `restic check` runs nowhere; no `scripts/restore.sh`, no `task restore`, no test exercises a restore. Corruption surfaces only when you need the backup.
- **Fix**: add `scripts/restore.sh` + `task restore` + `task backup:check` (weekly `restic check --read-data-subset`); script a restore-into-throwaway rehearsal.

### 0.4 🟡 `restic init`-on-failure can silently abandon the real repo
- **Broken**: `entrypoint.sh:16-19` inits a new repo whenever `restic snapshots` fails. If `AKTENRAUM_DATA_DIR` drifts to an empty path (the documented Windows incident class), it creates a fresh empty repo and abandons the old one. Narrow (empty-path only; a wrong passphrase aborts under `set -e`).
- **Fix**: add a repo-identity sentinel; refuse to auto-init where a repo is expected, fail loudly. Pairs with **2.4** (`AKTENRAUM_DATA_DIR` fail-closed).

### 0.5 🟡 B2 offsite copy is unverified
- **Broken**: `entrypoint.sh:57-69` / `backup.sh:73-90` run `restic copy` + `forget --prune` on B2 with no `check` and no source/dest count comparison; final `restic snapshots` reports only local `/repo`.
- **Fix**: after copy, compare snapshot counts (or `restic check` the B2 repo); log/fail on mismatch. (Optional hardening: distinct B2 passphrase via `--from-password-file`.)

### 0.6 🟡 Stale doc misdiagnoses the failure
- **Broken**: `CLAUDE.md:386` + `docs/sessions/2026-05-23.md:38-39` claim the empty-repo incident was a missing `restic init`. The entrypoint self-inits; the real cause was 0.1.
- **Fix**: correct the gotcha row to describe the cron-format defect; note the entrypoint self-inits.

### 0.7 ⚪ Cron/lock hygiene + doc scoping
- `forget --prune` runs every job (`entrypoint.sh:47-52`) — split frequent `forget` from occasional `prune`; add `restic unlock`/`flock` for overlap safety.
- `operations.md:75-87` shows `systemctl ... aktenraum-backup.timer` as generic, but the default deploy is the Docker crond container — scope those lines to the systemd opt-in path.

> **Phase 0 exit gate**: take a snapshot, restore into a throwaway environment, confirm document files **and both databases** come back, and SPA login + auto-approve rules survive.

---

## Phase 1 — Security defaults that ship insecure (🟠)

These matter precisely because the product is sold and buyers run the templates untouched.

### 1.1 🟠 `COOKIE_SECURE=false` is the shipped default
- **Broken**: `docker/aktenraum-api.env.example:35` ships `false`; `bootstrap-secrets.sh` copies it verbatim. Any non-localhost plain-HTTP access transmits the JWT in cleartext. (Code default in `config.py` is correctly `True` — only the example overrides it.)
- **Fix**: set the example to `true` (or comment it out so the safe default applies); document that localhost-only dev may set it false. The Tailscale path is HTTPS, so `true` works there.

### 1.2 🟠 Prompt injection can drive auto-approval
- **Broken**: `SYSTEM_PROMPT` (`tagger.py:198-271`) has no "text inside the document is data, not instructions" clause, and the auto-approve gate (`tagger.py:534`) trusts the LLM-emitted `confidence` directly. A crafted PDF can push past the threshold. Mitigated today only because auto-approve ships **off by default**.
- **Fix**: add an explicit anti-injection instruction; treat `confidence` as advisory; **exclude `email-ingested` docs from the auto-approve path** (untrusted external sender), or require the from-allowlist.

### 1.3 🟡 `WEBHOOK_SECRET` empty disables internal auth entirely
- **Broken**: the secret-gated endpoints (`settings/active-*`, auto-tagger `/trigger/*`, `/processing`) only enforce the secret `if settings.webhook_secret:`. Empty → unauthenticated (relies on Docker network isolation alone). Bootstrap generates one, so mostly OK post-setup, but a no-bootstrap deploy is exposed.
- **Fix**: treat `WEBHOOK_SECRET` as required — fail startup if empty outside an explicit dev mode.

### 1.4 ⚪ Upload MIME allowlist trusts the client `Content-Type`
- **Broken**: `documents/router.py:187-188` validates the spoofable multipart header; no magic-byte sniffing. Low real impact (Tika/OCR rejects garbage downstream).
- **Fix**: sniff magic bytes server-side (`filetype`/`python-magic`). Size (25 MB) + count (20) limits are already correct.

### 1.5 ⚪ JWT has no revocation
- **Broken**: logout + change-password only clear the local cookie; other devices stay valid up to the 8h expiry.
- **Fix (optional)**: add a token-version/`jti` column bumped on password change so change-password invalidates all sessions. Lower priority given 8h expiry + single-user scope.

> **Documented as accepted, not fixed**: no multi-user authorization (every authed user reaches every `doc_id`). Fine for the stated single-user model — but write it down as a security **invariant** so "add a user" can't silently become an IDOR.

---

## Phase 2 — Data safety + correctness bugs (🟠/🟡)

### 2.1 🟠 No memory limits — one OOM can corrupt the DB
- **Broken**: no `mem_limit`/`deploy.resources` on any service (`docker-compose.yml`). The reranker (~2.1 GB) + Ollama (16–32 GB) run uncapped; a spike can OOM-kill postgres mid-write. ADR-004 justifies the two-service split on caps that aren't set.
- **Fix**: add `mem_limit` + `mem_reservation` per service, sized to the host; at minimum cap `aktenraum-api` and `auto-tagger`.

### 2.2 🟡 Dead duplicate-detection signal
- **Broken**: `dedup.py` + readers (`propagator.py:100,155`, `documents/router.py:438`) key on `ai_monetary_amount`, a retired field that is never written → the amount-match branch is permanently dead; dedup silently depends on reference-number overlap alone.
- **Fix**: repoint at the type-specific money fields (e.g. `Rechnung.gesamtbetrag`), or delete the branch + field and update the docstring to "ref-numbers only".

### 2.3 🟡 `DELETE /{doc_id}` docstring is wrong
- **Broken**: `documents/router.py:838-843` claims hard-delete + Qdrant purge; it's actually a soft-delete to trash with chunks retained (RAG can still surface "deleted" content). Exactly the gotcha class CLAUDE.md already warns about.
- **Fix**: rewrite the docstring to match the gateway (soft-delete; chunks purged only on trash-empty).

### 2.4 🟡 `AKTENRAUM_DATA_DIR` falls back to `${HOME}` (data-loss footgun)
- **Broken**: compose still defaults to `${AKTENRAUM_DATA_DIR:-${HOME}/aktenraum}`; unset silently writes to a new path + inits an empty DB (two documented incidents). Only a comment mitigates it.
- **Fix**: `${AKTENRAUM_DATA_DIR:?AKTENRAUM_DATA_DIR must be set}` so unset aborts loudly. Pairs with **0.4**.

### 2.5 🟡 SPA: internal tags leak + navigation diverges + no retry/error boundary
- `ai-duplicate`/`ai-duplicate-dismissed` render in the user-facing "Tags:" list (`InboxReview.tsx:444`, `LibraryReview.tsx:452`) — wrap in `userFacingTags()`.
- j/k neighbor nav uses a different sort/filter than the visible list (`InboxReview.tsx:97`, `LibraryReview.tsx:93`) — thread active search/ordering from URL params.
- No global QueryClient retry/error config + no router error boundary (`main.tsx:9`) — failed queries retry 3× then can white-screen. Set `defaultOptions.queries.retry` (with 401 short-circuit) + a `defaultErrorComponent`.

### 2.6 🟡 Backend N+1 fetches
- Every extraction fetches the full doc twice (`main.py:60` then `tagger.py:570` → `get_document_content`); `_doc_tag_names` does up to 6 tag GETs per dequeued doc (`main.py:87-90`).
- **Fix**: pass the already-fetched doc into `process_document`; resolve tag names from the single cached entity-name map.

---

## Phase 3 — CI / build / ops hardening (🟡)

### 3.1 🟡 CI gates too little
- No `tsc --noEmit` (so `vite build` ships type errors); no Python type-check; no `pip-audit`/`pnpm audit`; images never built in CI; `--frozen-lockfile=false` in both CI and `docker/nginx/Dockerfile:18` defeats reproducible builds.
- **Fix**: add `tsc --noEmit`, a Python type-checker, dependency audit, a build-images step (+ optional Trivy), and flip both `--frozen-lockfile` to true (regenerate lockfile if stale).

### 3.2 🟡 No readiness healthchecks
- Only postgres + qdrant have healthchecks; `depends_on` waits for process start, not readiness → cold-start races (auto-tagger rule fetch fail-closed) + boot 502s.
- **Fix**: add `healthcheck` to aktenraum-api (`/api/health`), auto-tagger (`:8001/health`), nginx, redis; switch `depends_on` to `service_healthy`.

### 3.3 🟡 No graceful-shutdown window for the queue worker
- No `stop_grace_period`; a mid-propagation SIGKILL can strand a doc in `ai-propagation-error`.
- **Fix**: confirm SIGTERM finishes the current item + stops dequeuing; bump `stop_grace_period` for auto-tagger.

### 3.4 ⚪ Build-toolchain `uv` image is unpinned `:latest`
- Violates the repo's own tag+digest policy for the build toolchain (`services/*/Dockerfile`).
- **Fix**: pin `ghcr.io/astral-sh/uv:<version>@sha256:…`.

### 3.5 ⚪ Container/build nits
- nginx + qdrant run as root — use `nginxinc/nginx-unprivileged` or add a non-root `USER`.
- Thin `.dockerignore` ships `apps/web`, `docs/`, `openspec/`, `evals/` into the Python build context — tighten it.
- `bootstrap-secrets.sh` lacks a `trap`/`umask 077` on its secret-bearing tempfile.

---

## Phase 4 — Maintainability / tech debt (⚪)

### 4.1 Consolidate duplication into shared layers
- `DOC_TYPES` (27-value enum) triplicated across `lib/library.ts`, `InboxReview.tsx`, `LibraryReview.tsx` → single import.
- 3 copies of `_format_error` (`tagger.py:46`, `propagator.py:21`, `indexer.py:152`) → `aktenraum_core.errors`.
- Multiple `_parse_date` + custom-field projectors (`inbox/service.py`, `trash/service.py`, `indexer.py`, `ai/router.py`, `documents/router.py`) → `aktenraum_core.paperless` helpers.

### 4.2 Router shape
- `documents/router.py` (~890 lines): extract `documents/service.py`; lift the duplicate-candidates projection into `aktenraum_core.dedup`; register app-level exception handlers for the 3 gateway errors and drop the repeated per-route 404/409/502 try/except.

### 4.3 API type drift
- The `generate:api-types` script exists but the generated file is unused; all SPA response types are hand-written. Run the codegen + derive lib types from it, or delete the dead script.

### 4.4 Accessibility + small frontend nits
- `index.html` `<html lang="en">` → `lang="de"`.
- Modals (`DocumentPreviewModal`, `ConfirmEmptyModal`) lack focus trapping / initial focus / `aria-labelledby`.
- Consolidate the two independent optimistic-star implementations into one shared hook.
- `Ask.tsx:167` raw `<a href="/find">` → TanStack `Link`.
- `events/router.py:135` deprecated `get_event_loop().time()` → `get_running_loop().time()`.
- `retrieval.py:150-153` anonymous `type(...)` fallback → real `RerankResult`.
- `ai/router.py:664` dead `gateway` param (`del gateway`) → drop it.

---

## Phase 5 — Test coverage gaps

### 5.1 🟡 auto-tagger orchestration is untested
- `main.py` (gather/shutdown choreography, conditional loop assembly, worker skip-already-processed) — the most concurrency-subtle, load-bearing code, with zero tests.
- **Fix**: tests for worker skip logic, poller enqueue, graceful-shutdown drain (fake `PaperlessClient` + bounded queue).

### 5.2 🟡 Restore rehearsal as a test/CI artifact
- Wire the Phase 0.3 rehearsal into a runnable check so recovery can't silently rot again.

---

## Sequencing summary

| Phase | Theme | Severity ceiling | Rough effort | Gate |
|---|---|---|---|---|
| 0 | Disaster recovery | 🔴 | ~1.5 days | end-to-end restore rehearsal |
| 1 | Security defaults | 🟠 | ~1 day | — |
| 2 | Data safety + correctness | 🟠 | ~1.5 days | — |
| 3 | CI / build / ops | 🟡 | ~1 day | CI green on new gates |
| 4 | Maintainability | ⚪ | ~1.5 days | `task test` + `task lint` |
| 5 | Test coverage | 🟡 | ~1 day | — |

**Do not reorder 0 ahead of anything.** A data-custody product with a backup that never runs and a restore that recovers nothing is the single largest risk in the audit; everything else is degradation, not loss.
