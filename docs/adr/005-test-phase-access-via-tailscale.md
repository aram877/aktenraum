# ADR-005: Testing-Phase Remote Access via Tailscale

**Status**: Accepted

## Context

aktenraum is in the testing phase. The maintainer is the only user. The single highest-leverage observation they need to make is whether the end-to-end pipeline (intake → extraction → propagation → RAG answer) holds up against real, daily document flow. That observation cannot be made by sitting in front of one machine: a meaningful share of the intake workflow is mobile (photographing a Rechnung from the train, glancing at a Steuerbescheid from a coffee shop, capturing a receipt while shopping), and the maintainer's primary devices are split across a Windows desktop (the planned always-on host) and a phone + secondary laptop.

The compose stack today binds nginx to `127.0.0.1:${AKTENRAUM_WEB_PORT}` (default `8080`). That binding is correct for security but means only the host can reach the SPA. Validation requires a way to extend that access to other devices the maintainer controls, without:

- Exposing aktenraum to the public internet (the documents being processed include sensitive material — Steuer, Arztbrief, Ausweis, Gehaltsabrechnung — that the maintainer is not willing to put behind a public URL during testing).
- Putting documents on a cloud LLM provider, which would defeat the local-first thesis being tested.
- Locking in packaging decisions (Tauri Phase 0+) before product-market signal exists.

[ADR-002](002-distribution-desktop-app.md) commits aktenraum to a Tauri desktop app as the buyer-facing distribution shape. Quoting the relevant paragraph from that ADR:

> "The target buyer should be able to **double-click an installer and have a working system in under 10 minutes**, with no terminal usage."

That commitment is about a **buyer**, not the **maintainer-in-testing**. The Tauri Phase 0 work (self-bootstrapping compose, secrets generation, idempotent first-run, etc.) is correct as eventual work and is needed before any buyer touches the product. It is the **wrong** work for the testing phase because:

- It adds packaging effort to a product that has not yet been validated as worth packaging.
- It does not solve the maintainer's actual access problem (mobile validation from the maintainer's own devices).
- It risks investing in distribution shape decisions that real usage data might overturn.

Three real shapes of testing-phase remote access were considered:

1. **Tailscale private mesh.** Every authorised device joins a WireGuard mesh. MagicDNS gives the host a stable `<machine>.<tailnet>.ts.net` hostname. `tailscale serve` terminates TLS at the tailnet edge and proxies to a local port. No public exposure. No third-party traffic visibility. Free for personal use. iOS / Android / Windows / macOS / Linux clients.
2. **Cloudflare Tunnel + Cloudflare Access.** Public URL behind a tunnel; OIDC-gated by Cloudflare Access. Free tier covers personal use. Slightly wider attack surface (Cloudflare can technically see traffic; the OIDC proxy is the trust anchor).
3. **VPS deployment.** Rent compute; either keep local LLMs (CPU-only, slow) or swap to Anthropic. Always-on, no home-machine dependency. Breaks the local-first thesis because sensitive documents leave the maintainer's devices.

The maintainer has access to a Windows desktop that can stay powered on. Option 1 fits cleanly onto it: zero code changes (the existing CSRF middleware already accepts same-origin requests via `Sec-Fetch-Site`; nginx uses `server_name _;`; the `COOKIE_SECURE` env knob already defaults to `true`), one CLI command on the host, install the Tailscale app on the phone, done. Total setup ~15 minutes; reversibility is one command (`tailscale serve --remove`).

## Decision

For the **testing phase**, the accepted remote-access topology is:

1. The compose stack runs on a single always-on host machine (Windows desktop, in the maintainer's current setup; the topology works identically on macOS / Linux hosts).
2. The host has Tailscale installed and joined to the maintainer's tailnet.
3. `tailscale serve --bg --https=443 http://localhost:${AKTENRAUM_WEB_PORT:-8080}` is the documented proxy invocation. HTTPS termination happens at the Tailscale edge using a certificate issued from the Tailscale control plane.
4. The only documented access URL is `https://<host-machine-name>.<tailnet>.ts.net/`. Plain-HTTP LAN-IP access is explicitly discouraged due to the `COOKIE_SECURE=true` interaction.
5. Public exposure (`tailscale funnel`) is explicitly out of scope.
6. The runbook at [`docs/runbooks/tailscale-remote-access.md`](../runbooks/tailscale-remote-access.md) is the authoritative implementation guide.

**ADR-002 (Tauri desktop app) remains Accepted but its Phase 0 work is deferred** until the validation milestones below are met. ADR-002's content is preserved; only its Status line is updated to reference this ADR.

## Consequences

### What this enables

- **Mobile validation of the product.** The maintainer can use aktenraum from a phone, exercise the intake / search / Ask flows in realistic daily contexts, and gather the data that decides whether the product is worth packaging for buyers.
- **Same-day setup.** The runbook takes ~15 minutes end-to-end on a fresh host. The testing phase starts as soon as the change ships.
- **Reversibility.** A single `tailscale serve --remove` reverts the host to localhost-only access. Nothing else to undo. If Tailscale turns out to be the wrong choice we lose a runbook, not a code direction.
- **Sustained local-first thesis testing.** Sensitive documents never leave the host machine. The Tailscale data plane is peer-to-peer WireGuard; Tailscale's control plane sees only coordination metadata (which devices exist), never document content.
- **No code surface change.** The existing CSRF middleware, nginx Host handling, and `COOKIE_SECURE` env knob all already accommodate this topology. No reviewable code lands.

### What this constrains

- **Tauri Phase 0 work is paused.** `docs/plans/desktop-app.md` Phase 0 is shelved until the milestones below are met. The plan is not deleted — it resumes from where it paused. This means:
  - Self-bootstrapping compose (secrets generation, idempotency hardening, model auto-pull, configurable data dir) does not happen now.
  - Health endpoints stay at their current coverage (`/api/health` only); the per-service health endpoint expansion is deferred.
  - SIGTERM graceful-shutdown hardening is deferred.
  - Hardware preflight is deferred.
- **The host machine must stay powered on and awake.** The runbook flags this; the maintainer is expected to choose a machine that satisfies the constraint. If the maintainer's chosen host is unreliable, the answer is to pick a different host, not to relax the topology.
- **Single-user access only.** aktenraum's `users` table is seeded with one bootstrap user; remote access changes nothing about that. Multi-user is a separate concern; tailnet device sharing (inviting a household member) is documented as out-of-scope.

### What this explicitly does not replace

- **The buyer-facing distribution decision.** ADR-002's analysis of distribution shapes (Docker tarball vs Tauri vs NAS appliance) remains correct. Tauri is still the buyer-facing answer when validation is complete. ADR-005 narrows sequencing only.
- **Production access topology.** A maintainer running aktenraum for a non-technical buyer would not configure tailnets on the buyer's behalf. Production-facing access topology is part of ADR-002's purview and is unchanged here.
- **The compose stack architecture.** No services move, no databases are renamed, no ports change. The change is a thin deployment-side overlay.

### What gets harder

- **One distribution shape to maintain temporarily** (the developer / maintainer flow via `docker compose up -d` + Tailscale), but only until Tauri Phase 0 resumes. After that, both flows must coexist as ADR-002 requires.
- **No installer for the maintainer.** Setup is manual (one runbook, ~15 min). Acceptable because the maintainer is the only user during this phase.

### What gets easier later

- **Tauri Phase 0 resumes with better requirements.** The 30+ days of remote-access usage produces concrete data about what the bootstrap flow needs to handle (network conditions, mobile-specific bugs, real document mix). Phase 0 ships against measured requirements rather than imagined ones.

## Milestones for un-deferring Tauri

ADR-002's Phase 0 work resumes when **all** of the following are concurrently true:

1. **Sustained usage**: The maintainer has used aktenraum daily for at least **30 calendar days**, primarily via Tailscale remote access from at least one mobile device. Measured by: presence of activity in the propagated corpus across at least 30 distinct calendar dates within a 45-day window.

2. **Corpus volume**: The propagated corpus contains at least **200 distinct documents** spanning at least **10 of the 26 DocumentType enum values**. Measured by: `SELECT count(*), document_type FROM documents WHERE 'ai-propagated' = ANY(tags) GROUP BY document_type` on the live Paperless database.

3. **RAG quality floor**: The RAG eval harness (`task rag:eval`) reports **recall@5 ≥ 0.7** and **MRR ≥ 0.5** on the maintainer's golden-questions set (which must itself contain at least 20 questions). The threshold is the floor — actual passage from "tested" to "shippable" is a separate decision; this floor merely confirms retrieval isn't broken enough to invalidate the product.

4. **External validation signal**: At least **one prospective buyer outside the maintainer's household** has expressed concrete interest — measured by any of: a paid pre-order, a signed wait-list commitment, a documented interview where they describe the product solving a real pain they currently experience.

Each condition is falsifiable by inspection. If at the end of the testing phase the milestones are not met, the next decision is either to revise the product (not the distribution) or to retire it — not to ship Tauri to nobody.

## Related

- [ADR-002: Distribution — Tauri Desktop App Wrapping Docker](002-distribution-desktop-app.md) — status updated to reference this ADR.
- [`docs/runbooks/tailscale-remote-access.md`](../runbooks/tailscale-remote-access.md) — the implementation runbook.
- [`docs/plans/desktop-app.md`](../plans/desktop-app.md) — Tauri phased roadmap (Phase 0 paused per this ADR).
- [`openspec/changes/tailscale-remote-access/`](../../openspec/changes/tailscale-remote-access/) — the OpenSpec change that introduced this ADR.
