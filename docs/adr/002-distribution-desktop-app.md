# ADR-002: Distribution — Tauri Desktop App Wrapping Docker

**Status**: Accepted

## Context

aktenraum is being built for sale to non-technical buyers (privacy-conscious solo professionals, small teams) who want a self-hosted, local-LLM document management system without managing Docker, env files, model downloads, or DB migrations themselves. The target buyer should be able to **double-click an installer and have a working system in under 10 minutes**, with no terminal usage.

Three distribution shapes were considered:

1. **Docker Compose tarball + install script.** Lowest effort. Buyer must already have Docker Desktop or Docker Engine and is comfortable running `./install.sh`. This rules out the majority of the target market.

2. **Native desktop app wrapping Docker (Tauri shell).** A small Rust-shell desktop application that bundles or auto-installs Docker, manages the compose stack underneath, exposes a system-tray icon for status/start/stop, handles auto-updates, and opens the browser to the local SPA. Same model Ollama itself ships on macOS. The buyer never sees Docker.

3. **NAS appliance / VM image.** Synology/Unraid/Proxmox/TrueNAS one-click apps. Premium niche. Customer base too small to be the primary distribution shape, but worth shipping later as a complement.

The decision affects the architecture of the compose stack itself: every secret, path, and bootstrap step that today assumes "a developer in a terminal" must instead be either generated automatically on first run or provisioned by the desktop shell. These changes are **cheap if decided now** and **expensive to retrofit** after multiple features have been built on top.

## Decision

We will build aktenraum's primary distribution as a **Tauri desktop app that wraps the existing Docker Compose stack**. The desktop app is the product the buyer installs; the compose stack is its private backend.

The Docker Compose stack remains the source of truth for service orchestration and stays runnable by developers via `docker compose up -d` for hacking and CI. The Tauri app is a thin shell that delegates all heavy lifting (Postgres, Paperless, Ollama, our services) to the compose stack — we are not rewriting any service as native code.

Path #1 (Docker bundle) is **deferred indefinitely**. We jump directly to #2 because the target market cannot install Docker themselves. Path #3 (NAS) may be added later as a separate distribution shape.

## Consequences

### What this enables
- Non-technical buyers can install and use the product without ever opening a terminal.
- The buyer pool widens from "Docker-comfortable self-hosters" (~thousands) to "anyone who can install a desktop app" (~millions).
- The desktop shell becomes the natural place for license validation, telemetry opt-in, update prompts, and onboarding.

### What this constrains in *every* future change

These rules are binding from this ADR forward:

1. **No committed secrets and no developer-only env defaults.** Every runtime secret (`JWT_SECRET`, `WEBHOOK_SECRET`, `PAPERLESS_DBPASS`, `RESTIC_PASSWORD`, `PAPERLESS_API_TOKEN`, `BOOTSTRAP_PASSWORD`) must be generated on first run by a bootstrap script and persisted to a per-install env file under the user's data directory. `.env.example` files in the repo carry only placeholders.

2. **All paths come from environment variables, no hardcoded `~/aktenraum/`.** The data directory is configurable via `AKTENRAUM_DATA_DIR`, defaulting to platform-appropriate locations: `~/Library/Application Support/aktenraum/` on macOS, `%APPDATA%\aktenraum\` on Windows, `$XDG_DATA_HOME/aktenraum/` on Linux. Audit `scripts/`, `docker-compose.yml`, and any service that touches the filesystem.

3. **Models are downloaded on first run, not bundled.** Qwen 2.5 14B Q4 (~9 GB), bge-m3 (~2 GB), and bge-reranker-v2-m3 (~600 MB) total ~12 GB. The bootstrap script invokes `ollama pull` with progress reported to the desktop shell. The installer itself stays small (<200 MB).

4. **No fork of Paperless-ngx.** We orchestrate around Paperless via its REST API (aggregation), never modify its source (which would trigger GPLv3 distribution requirements on our wrapper). Patches, if needed, must go upstream as PRs.

5. **First-run is idempotent and detectable.** Every bootstrap step (secret generation, env writing, image pull, DB migration, model pull, custom-field/tag creation in Paperless) is safe to re-run. The desktop shell uses idempotency to recover from interrupted installs without manual cleanup.

6. **Health endpoints exist for every service.** The desktop shell polls them to render service-by-service status (postgres → starting/healthy/failed, paperless → …, aktenraum-api → …, ollama → model-loaded). Today only `/api/health` exists; this must extend.

7. **Graceful shutdown via SIGTERM.** No service may rely on `SIGKILL`-time persistence. Each must drain in-flight work (auto-tagger queue, aktenraum-api requests) within a 30-second window when the user quits the desktop app.

8. **Telemetry is opt-in, off by default.** Privacy-first buyers will reject any forced reporting. License validation is offline-first via signed-license file; cloud check-in is opt-in for update notifications only.

9. **No service writes to another service's database.** auto-tagger talks to Paperless via API only; aktenraum-api owns the `aktenraum` database; alembic migrations are scoped per service. Auto-update can pull new images and run migrations without manual SQL.

10. **Hardware preflight runs before any download.** A Rust-side check (RAM ≥ 16 GB, free disk ≥ 50 GB, Apple Silicon or AVX2-capable x86, optional GPU detection) bails with a friendly message *before* the user has waited for a 12 GB download to fail.

### What gets harder
- **Two distribution surfaces to maintain.** Developer flow (`docker compose up -d`) and end-user flow (Tauri app) must both keep working; CI tests both.
- **Auto-update gets non-trivial.** New compose-stack versions must run alembic migrations on startup (already true) but also handle Ollama model migrations and Paperless schema migrations without breaking running data.
- **Cross-platform packaging.** Tauri builds a distinct artifact per OS (macOS Universal `.dmg`, Windows `.msi`, Linux `.AppImage`/`.deb`), each with its own signing/notarization pipeline. CI must run on at least three runner types.
- **Docker-on-Windows is messier than on macOS.** macOS users get Docker Desktop reliably; Windows users may need WSL2-based Docker. The desktop shell must detect and guide.

### What gets easier later
- **License enforcement.** A signed license file lives in the user's data directory; the desktop shell validates it on launch. No server required for the privacy-first claim to hold.
- **Onboarding and recovery.** First-run wizard, error UI, model re-download, "reset to factory" — all live in the desktop shell, not as command-line scripts.
- **Telemetry pipeline.** When the user opts in, the shell is the natural collector; no per-service phone-home code needed.

## Phase sequencing

Implementation is captured separately in `docs/plans/desktop-app.md`. At a high level:

- **Phase 0 — Self-bootstrapping compose.** Make the existing stack first-run-safe in a terminal: secrets generated, paths configurable, models auto-pulled, health endpoints complete. No Tauri yet.
- **Phase 1 — Tauri shell minimum viable.** Wrap the compose stack with start/stop/status, browser launcher, system tray.
- **Phase 2 — First-run wizard + auto-update.** Onboarding, hardware preflight, image and model download UI, update prompts.
- **Phase 3 — Polish for sale.** Signed license, opt-in telemetry, marketing pages, DMG/MSI/AppImage signing, notarization.

Phase 0 is the immediate prerequisite for everything else and starts before any Rust code is written.

## Related

- Built on top of: `docs/plans/custom-frontend.md` (the SPA the desktop shell launches into).
- Replaces the implicit "Docker tarball" assumption in earlier planning.
