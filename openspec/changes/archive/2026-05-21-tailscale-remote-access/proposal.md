## Why

aktenraum binds to `127.0.0.1:8080` by design — only the host machine can reach it today. The product is in the testing phase: the maintainer is using it daily to find bugs, validate the AI quality, and decide whether the local-first thesis is worth taking further. That validation can't happen from a single laptop. Real intake is mobile (photos of receipts from the train, glancing at a Rechnung from the phone during the day, asking "did I file my last Steuerbescheid?" while away from the desk).

ADR-002 commits us to a Tauri desktop app as the eventual distribution shape, but Tauri is premature for the testing phase: it would lock in packaging decisions before we know whether the product is worth shipping, and the desktop shell adds zero feedback value during validation. The buyer-facing installer is a Phase-2 problem; the Phase-1 problem is "let the maintainer use the system from any of their own devices, securely, without putting documents on the public internet".

The constraint that rules out cloud hosting is local LLMs: `qwen2.5:32b` (32 GB), `bge-m3` (~2 GB), `bge-reranker-v2-m3` (~2 GB) all run via Ollama on the host. A VPS small enough to be affordable for testing can't run them, and swapping to `LLM_BACKEND=anthropic` for everything would ship sensitive docs (Steuer, Arztbrief, Ausweis) to a cloud LLM provider — defeating the local-first thesis we're testing.

Tailscale solves this directly: a private mesh network gives every authorised device a stable hostname with end-to-end-encrypted WireGuard transport and automatic TLS via MagicDNS. No public port. No third party can see traffic. The maintainer's phone and second laptop see the same `https://aktenraum.<tailnet>.ts.net` URL the host serves locally. Zero code changes required — the existing CSRF middleware already accepts `Sec-Fetch-Site: same-origin` (which a Tailscale-hosted SPA produces when calling its own `/api`), nginx uses `server_name _;` (accepts any Host header), and the `COOKIE_SECURE` env flag already exists for the HTTPS case.

The change is mostly a runbook + an ADR that explicitly defers Tauri to post-validation. The code surface is tiny (one env-file note about `COOKIE_SECURE=true` under HTTPS), so this is reversible — if Tailscale doesn't work out we lose a runbook, not a code direction.

## What Changes

- **New runbook** `docs/runbooks/tailscale-remote-access.md` covering, end-to-end, how to enable Tailscale on the host machine, configure `tailscale serve` to proxy `https://aktenraum.<tailnet>.ts.net → 127.0.0.1:8080`, validate from a second device, and recover from common failure modes (MagicDNS off, ACL blocking, cookie not sent).
- **New ADR** `docs/adr/005-test-phase-access-via-tailscale.md`. Marks Tailscale + existing Docker Compose stack as the accepted access topology for the testing phase. Explicitly defers ADR-002's Tauri direction — it remains "Accepted" but its Phase 0 work is paused until product-validation milestones are met (criteria spelled out in the new ADR). This is a tightening of ADR-002, not a reversal.
- **Bootstrap-secrets behaviour** is unchanged. `COOKIE_SECURE` keeps its existing default (`true`) so the production default is correct; localhost dev keeps its explicit `COOKIE_SECURE=false` in `docker/aktenraum-api.env`. The runbook simply tells the user to leave `COOKIE_SECURE` at its default when accessing via Tailscale HTTPS.
- **`.env.example` documentation** in `docker/aktenraum-api.env.example` gains a short comment block above `COOKIE_SECURE` explaining the trade-off (false → required for plain-http://localhost dev; true → required when accessed over Tailscale HTTPS).
- **CLAUDE.md** gains a new row in "What's implemented vs planned" (Tailscale remote access — ✅ Available via runbook), a new gotchas row (cookie won't be sent if `COOKIE_SECURE=true` and the user hits the LAN IP over plain HTTP; correct fix is to use the Tailscale MagicDNS hostname which always serves HTTPS), and a one-line addition to the "Distribution direction (binding)" block pointing to ADR-005.
- **Taskfile shortcut** `task tailscale:serve` and `task tailscale:status` — wrap the two `tailscale serve` / `tailscale serve status` invocations so the operator doesn't have to remember the flags.
- **No changes to**: CSRF middleware (already correct), nginx config (already accepts any Host), `aktenraum-api` cookie code (`COOKIE_SECURE` already does the right thing), `docker-compose.yml` (Tailscale runs on the host, not as a sidecar — keeps the compose stack identical to dev).
- **Out of scope for this change** (intentionally — separate decisions):
  - Tailscale Docker sidecar (for headless Linux servers without the macOS Tailscale-Desktop app). Pattern documented in the runbook as an alternative, but the default path is host-installed Tailscale.
  - Public access via `tailscale funnel`. The threat model for funnel (anyone on the internet can reach the URL, gated only by aktenraum's auth) is wider than `tailscale serve` (only devices in the tailnet can reach it). Stay with `serve` for testing.
  - Tauri Phase 0 (self-bootstrapping compose). Deferred per ADR-005 until validation milestones are met. Phase 0 still belongs in the repo's plans/ directory; this change does not delete `docs/plans/desktop-app.md`.

## Capabilities

### New Capabilities
- `remote-access`: the deployment surface that lets the maintainer's authorised devices reach the existing Docker Compose stack over a private Tailscale mesh, without exposing aktenraum to the public internet. Covers the runbook contract (what steps the operator follows, in what order), the operational expectations (HTTPS via MagicDNS, devices in the same tailnet only, no public funnel), and the configuration assumptions (`COOKIE_SECURE=true`, host-installed Tailscale on a machine that stays on most of the time).

### Modified Capabilities
None. The existing `aktenraum-api` auth and CSRF behaviour already accommodates this topology; no requirement changes.

## Impact

- **Code**: none directly. `docker/aktenraum-api.env.example` gains a comment block; `Taskfile.yml` gains two wrapper tasks (`tailscale:serve`, `tailscale:status`).
- **Documentation**:
  - `docs/runbooks/tailscale-remote-access.md` — new runbook.
  - `docs/adr/005-test-phase-access-via-tailscale.md` — new ADR.
  - `CLAUDE.md` — implemented-vs-planned row, gotcha row, ADR-005 pointer in the "Distribution direction" block.
- **Operational change for the maintainer**: install Tailscale on the host machine (~5 min), run `tailscale serve --bg --https=443 http://localhost:8080` (~10 s), install Tailscale on phone + secondary laptop (App Store / Play Store), visit `https://aktenraum.<tailnet>.ts.net` from those devices. Total setup ~15 min for the first time, zero overhead afterwards.
- **Reversibility**: `tailscale serve --remove` on the host disables the exposure; the compose stack continues to serve only on `127.0.0.1:8080`. Nothing else to undo.
- **Threat model**: tightened from "anyone on the host LAN can reach `:8080`" to "only devices the maintainer has authorised in their tailnet can reach the URL". The aktenraum-api login still gates access; Tailscale is the transport, not the only line of defence.
- **What this does NOT validate**: the buyer's experience. Tailscale is a maintainer-only access strategy; non-technical buyers will not configure tailnets. The Tauri direction (ADR-002) is the buyer-facing path and stays accepted-but-deferred. ADR-005 is the formal record of that deferral.
