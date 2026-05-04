# Desktop app — multi-phase roadmap

The durable plan for shipping aktenraum as a Tauri desktop app per ADR-002. Lives outside the OpenSpec change pipeline because it spans multiple deliveries; each phase becomes its own OpenSpec change when implementation starts.

**Status**: Phase 0 not started. ADR-002 accepted.

---

## Goal

A non-technical buyer downloads `aktenraum.dmg` (macOS) / `aktenraum.msi` (Windows) / `aktenraum.AppImage` (Linux), double-clicks, follows a 5-step wizard, and 10 minutes later has a working local-LLM document management system. They never type a command, never edit a file, never see the word "Docker."

## Non-goals

- Replacing the developer flow. `docker compose up -d` from the repo root must keep working for development and CI, and the Tauri app must consume that same compose stack — not a separate native runtime.
- Building a hosted/SaaS version. The privacy-first claim ("your documents never leave your machine") is the wedge; defer cloud distribution indefinitely.
- Rewriting any service in Rust. Tauri is a thin shell only.

## Constraints

- Same hardware target as ADR-002: 16 GB RAM minimum, 32 GB recommended, Apple Silicon or AVX2 x86, ~50 GB free disk.
- macOS, Windows, and Linux must all ship from day one (Tauri makes this cheap; skipping any locks us out of segments).
- No telemetry without explicit consent.
- Auto-updates must roll forward DB schemas without data loss.

## Phase 0 — Self-bootstrapping compose stack

**Outcome**: a developer (or future Tauri shell) can run a single command in any directory and end up with a working stack — no manual `.env` editing, no `bootstrap-paperless.sh` invocation, no `ollama pull` mental load.

Concrete deliverables:

1. **`scripts/bootstrap.sh`** — idempotent. On first run:
   - Generates `JWT_SECRET`, `WEBHOOK_SECRET`, `PAPERLESS_DBPASS`, `RESTIC_PASSWORD`, `BOOTSTRAP_PASSWORD` via `openssl rand -base64 32`.
   - Writes them to `${AKTENRAUM_DATA_DIR}/env/{paperless,auto-tagger,aktenraum-api,backup}.env`.
   - Mints `PAPERLESS_API_TOKEN` after Paperless first start; injects it into the auto-tagger and aktenraum-api env files.
   - Surfaces the auto-generated admin password ONCE for the user to record.
   - Re-runs are no-ops once env files exist.

2. **`AKTENRAUM_DATA_DIR` end-to-end.** Audit and replace every reference to `~/aktenraum/`:
   - `docker-compose.yml` volume mounts.
   - `scripts/bootstrap-paperless.sh` and friends.
   - `services/aktenraum-api/src/aktenraum_api/config.py` (data paths, if any).
   - Default per-platform: `~/Library/Application Support/aktenraum/` (macOS), `%APPDATA%\aktenraum\` (Windows), `$XDG_DATA_HOME/aktenraum/` (Linux).

3. **Model pull on first run.** Extend `bootstrap.sh` (or split into `scripts/pull-models.sh`) to:
   - Detect Ollama is reachable.
   - `ollama pull qwen2.5:14b-instruct-q4_K_M` (chat).
   - `ollama pull bge-m3` (embeddings, when RAG ships).
   - `ollama pull bge-reranker-v2-m3` (reranker, when RAG ships).
   - Stream pull progress as line-prefixed JSON for the desktop shell to parse.

4. **Health endpoints completed for every service.**
   - `aktenraum-api`: `/api/health` exists; extend with subchecks (`db_ok`, `paperless_ok`, `ollama_ok`).
   - `auto-tagger`: add `GET /health` to its aiohttp listener (currently webhook-only).
   - `paperless`, `postgres`, `redis`: rely on Docker `healthcheck:` directives in compose; the desktop shell polls `docker compose ps --format json`.

5. **Single-command first-run path.** A `scripts/first-run.sh` (or a `make first-run` target) that orchestrates: preflight → bootstrap → image pull → compose up → wait healthy → bootstrap-paperless → model pull → print "ready, open http://localhost:8080".

6. **Hardware preflight script.** `scripts/preflight.sh` checks RAM, free disk, CPU features, Docker presence, port availability (8080, 8000). Fails with friendly messages, not stack traces.

7. **Graceful shutdown.** `auto-tagger` and `aktenraum-api` already use SIGTERM-aware lifespans (FastAPI/asyncio). Add a 30s drain test to CI.

Phase 0 ships entirely as shell scripts and config; **no Rust, no Tauri**. The deliverable is "the compose stack is now wrappable."

## Phase 1 — Tauri shell minimum viable

**Outcome**: a buyer can install the desktop app, click "Start aktenraum," and reach the SPA in their browser without ever touching a terminal.

Concrete deliverables:

1. **`apps/desktop/`** — new Tauri 2.x project.
   - Rust shell embeds the compose stack as bundled `docker-compose.yml` plus `bootstrap.sh`.
   - On launch: detect Docker → if missing, prompt user to install Docker Desktop with a deep link to docker.com.
   - Run `first-run.sh` on first launch with progress events streamed to a Tauri window.
   - System tray: Start / Stop / Open Browser / Show Logs / Quit.

2. **Status panel.** A small native window (or in the system-tray menu) showing each service's health, derived from the health endpoints above.

3. **Browser launcher.** "Open aktenraum" opens the user's default browser at `http://localhost:8080`. The SPA itself is unchanged.

4. **Log viewer.** Pipes `docker compose logs -f` into a scrollable native window for support diagnostics.

5. **CI matrix.** Build the macOS Universal `.dmg`, Windows `.msi`, and Linux `.AppImage` on every push to a release branch. No signing yet.

Out of scope for Phase 1: license validation, onboarding wizard, auto-update, telemetry. Phase 1 is "it runs on a non-technical user's machine."

## Phase 2 — First-run wizard, auto-update, model UX

**Outcome**: the install-to-working time drops to under 10 minutes for a non-technical user with no prior context.

Concrete deliverables:

1. **First-run wizard** in Tauri:
   - Welcome screen with hardware preflight result.
   - Disk-space allocation slider (show the ~12 GB model footprint upfront).
   - Admin password reveal screen (the auto-generated one; let the user copy or change it).
   - Model download progress per model with ETAs.
   - "You're ready" → opens browser.

2. **Auto-update.** Tauri's updater plugin checks a signed manifest periodically, prompts the user, downloads the new version, runs `docker compose pull && up -d` underneath, and waits for migrations to complete.

3. **Model management UI.** Settings panel: list installed models, swap chat model, redownload, delete. Useful for the "qwen 14B is too slow on my machine, try the 8B" flow.

4. **Backup UI.** Surface restic snapshots, "back up now" button, "restore from snapshot" wizard. The restic infra exists; the UI does not.

5. **Diagnostics export.** "Export support bundle" → tarball with logs (sanitized), config (secrets redacted), and `docker compose ps` for emailing to support.

## Phase 3 — Polish for sale

**Outcome**: the product is shippable as a paid SaaS-style desktop app.

Concrete deliverables:

1. **Code signing + notarization.** Apple Developer ID for macOS notarization, Windows Authenticode certificate, Linux GPG-signed AppImage. Without these, macOS Gatekeeper and Windows SmartScreen will scare users off.

2. **Signed license file.** Offline-first validation: user pastes a `.license` file (or it ships in the `.dmg`); Tauri validates the Ed25519 signature on every launch. License server is a static CDN that hosts revocation lists only; no required check-in.

3. **Opt-in telemetry.** Settings toggle, defaults off. When on, anonymized usage events go to a self-hosted PostHog instance. Privacy policy linked from the toggle.

4. **Onboarding tutorial.** A "tour" overlay on first SPA launch — "this is the inbox, this is search, drop a PDF here." Closes forever after dismissal.

5. **Marketing site.** Static, ships separately from the product. Links to download artifacts.

6. **Recovery flows.** "My install is broken" → reset to factory, restore from backup, reinstall models. All from the desktop shell, no terminal.

## Risks and open questions

- **Docker-on-Windows reliability.** Docker Desktop on Windows requires WSL2 or Hyper-V; some corporate/Home edition machines can't run either. We may need to ship a Podman-based fallback. Decision deferred to Phase 1; investigate in a spike before committing to a single runtime.
- **Apple notarization for binaries that ship Docker.** Notarization scans Docker as a sub-process — may flag the bundled binaries. Plan to spike this in Phase 3 well before launch.
- **GPLv3 boundary.** Confirm with a lawyer before charging money: orchestration via REST API around Paperless is fine; bundling Paperless's UI assets in our installer would be a derivative-work risk. Audit before Phase 3.
- **Model size vs. Apple's app-bundle limits.** macOS App Store limits installer size; we won't use the App Store (notarized DMG only) but it's worth confirming there are no other size ceilings.
- **License key fairness vs. ease of piracy.** A signed offline license can be shared. We accept this as a tradeoff for the privacy-first promise; revenue model assumes the buyer-tier where piracy is a small share of total demand (B2B SaaS-replacement, not consumer software).

## Tracking

Each phase becomes its own OpenSpec change when implementation starts:
- `openspec/changes/desktop-phase-0-bootstrap/`
- `openspec/changes/desktop-phase-1-tauri-shell/`
- etc.

Phase 0 is the only one with no Rust code — it lives in `scripts/` and `docker/` and ships as part of the existing repo. Phases 1+ introduce `apps/desktop/`.
