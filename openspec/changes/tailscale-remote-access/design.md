## Context

aktenraum's current access topology is "the maintainer SSHes into nothing, they sit in front of the host machine and visit `http://localhost:8080`". The compose stack publishes nginx on `127.0.0.1:8080` (overridable via `AKTENRAUM_WEB_PORT`), which is intentional — binding to a public interface would be insecure-by-default. The trade-off: nobody but the host can reach the SPA today.

The product is in the testing phase. The single highest-leverage observation the maintainer needs to make is whether the AI metadata + RAG answer pipeline is good enough on real, daily intake — receipts photographed on a phone, Rechnungen forwarded from email, a Steuerbescheid the maintainer wants to glance at from a coffee shop. None of those workflows are exercised by sitting in front of one machine.

The buyer-facing solution to this (ADR-002 Tauri desktop app) is a packaging concern, not an access concern. It does not let the maintainer test remotely. It does not let them validate the product. Building Tauri Phase 0 (self-bootstrapping compose) is correct as eventual work; it is the wrong work for this phase.

Three real shapes of remote access exist:

1. **Tailscale (private mesh)**: every authorised device joins a WireGuard mesh; MagicDNS gives the host a stable `<machine>.<tailnet>.ts.net` hostname; `tailscale serve` terminates TLS and proxies to a local port. No public exposure. No third-party traffic visibility. Free for personal use. Works on iOS / Android / macOS / Windows / Linux. The maintainer's phone joins the tailnet via App Store.
2. **Cloudflare Tunnel + Cloudflare Access**: public URL behind a tunnel; Cloudflare Access gates with OIDC. Free tier covers personal use. Slightly more attack surface (Cloudflare can technically see traffic; the auth proxy is the trust anchor).
3. **VPS deployment**: rent compute; either keep local LLMs (CPU-only, slow) or swap to Anthropic. Always-on, no home-machine dependency. Breaks the local-first thesis because sensitive docs leave the maintainer's devices.

The maintainer chose (1). They have a desktop / NUC / Mac mini that stays on; Tailscale fits cleanly onto it.

The code surface affected by this choice is surprisingly small because most of the design work was done preemptively:

- `services/aktenraum-api/src/aktenraum_api/middleware.py` already accepts `Sec-Fetch-Site: same-origin` and the docstring already mentions Tailscale by name. A Tailscale-hosted SPA at `https://aktenraum.<tailnet>.ts.net/` calling `/api/...` is same-origin → passes the CSRF check.
- `docker/nginx/nginx.conf` already uses `server_name _;` — accepts any Host header.
- `services/aktenraum-api/src/aktenraum_api/config.py` already has `COOKIE_SECURE` with default `true`; the auth cookie is issued with the `Secure` flag in production.
- The `WEBHOOK_SECRET` flow (auto-tagger trigger, paperless post_consume) all happens inside the compose network, doesn't touch the Tailscale exit, doesn't need any change.

So the change is shaped as a documentation drop plus a one-line `.env.example` clarification, plus an ADR that records the deferral of Tauri. The risk surface is "did the maintainer follow the runbook correctly", not "did the code break".

## Goals / Non-Goals

**Goals:**

- The maintainer can reach the existing SPA from their phone and second laptop at `https://aktenraum.<tailnet>.ts.net` within 15 minutes of starting the runbook.
- No public-internet exposure. The only way to reach the URL is to be a device on the maintainer's tailnet.
- HTTPS by default. The runbook does not include an HTTP variant — when accessed via Tailscale, the connection is TLS-terminated at the Tailscale edge using a cert minted from the Tailscale control plane.
- Zero changes to the compose stack itself — the runbook does not edit `docker-compose.yml`. The maintainer can roll back by running `tailscale serve --remove` and is back to localhost-only access.
- ADR-005 records the trade-off explicitly: ADR-002 (Tauri) is deferred, not abandoned. The criteria for un-deferring are concrete, not "when we feel ready".

**Non-Goals:**

- A buyer-facing distribution mechanism. Buyers will not configure tailnets. The Tauri path is still the buyer-facing answer; this change does not displace it, only sequences it after validation.
- `tailscale funnel` — public exposure of the URL to the open internet, gated only by aktenraum's own auth. The threat model widens (botnets brute-force the login, the JWT secret becomes a high-value target, the auto-tagger webhook bypass becomes a public endpoint). Stay with `serve`.
- A Tailscale Docker sidecar baked into `docker-compose.yml`. The sidecar pattern is the canonical answer for headless Linux servers, but it adds (a) an auth-key management problem (where does the key come from? committed env file? bootstrap-secrets generation?) and (b) a state-machine for the sidecar to come up before nginx so the maintainer doesn't see a connection hole. The runbook documents this pattern as an alternative; it isn't the default.
- Mutual TLS / client certs / extra auth on top of aktenraum's login. The tailnet membership is the perimeter; aktenraum's login is the secondary line of defence. Two factors at the perimeter would slow daily use without changing the threat model meaningfully (an attacker who controls a tailnet member already won by then).
- Multi-user support. Today aktenraum has a `users` table seeded with one bootstrap user; remote access doesn't change that. Tailscale device sharing (inviting a household member to a tailnet) is documented as out-of-scope; the household member could log in as the same bootstrap user, which is a different problem.

## Decisions

### 1. `tailscale serve` on the host, not a Docker sidecar

`tailscale serve --bg --https=443 http://localhost:8080` is one command, runs on the host machine, persists across reboots (via `--bg`), and produces a working HTTPS URL via MagicDNS within seconds. The Tailscale Desktop app on macOS already handles MagicDNS provisioning, machine-name configuration, and the systemd / launchd integration.

The Docker-sidecar pattern (`tailscale/tailscale` image in the compose file) was considered and rejected for the default path:

- It adds a startup ordering dependency: nginx must be up before the sidecar advertises the service, but the sidecar must be up before any external traffic reaches nginx. Compose's `depends_on` doesn't model this cleanly without health checks.
- It requires an auth key. Reusable auth keys are convenient but security-spongy (committed somewhere); one-time keys break the maintainer's "I rebuild this stack frequently" workflow. The host install uses interactive `tailscale up` and bypasses this.
- It complicates the data-locality story. The maintainer wants to be confident that "if I look at top, I can see all the processes that touch my documents". Adding another container that proxies the data path widens the attack surface for unclear gain.

We document the sidecar pattern in the runbook as the "headless Linux server" alternative. If the maintainer later moves aktenraum to a Linux NUC running headless, they can switch.

### 2. `COOKIE_SECURE=true` is the default; the runbook tells the maintainer NOT to override it

The aktenraum-api config already defaults `cookie_secure: bool = True`. The localhost-dev override sets it to `false` because Safari and Chrome won't send a `Secure` cookie over plain `http://localhost`. When the maintainer accesses aktenraum via Tailscale, the URL is `https://aktenraum.<tailnet>.ts.net/` — a valid TLS connection — so `Secure` cookies are sent normally.

The trap the runbook explicitly warns against: visiting the host's LAN IP at `http://<lan-ip>:<AKTENRAUM_WEB_PORT>` over plain HTTP. The login will appear to succeed (the server sets the cookie) but the browser will refuse to send the `Secure` cookie back on subsequent requests; the user will see a silent 401 on `/api/auth/me` and bounce back to the login page indefinitely. The diagnostic is "cookie set, never sent" — visible in DevTools.

Two ways to avoid this:
- (a) Use the Tailscale MagicDNS hostname (the runbook makes this the only documented access path). HTTPS is automatic, the cookie flows.
- (b) For genuinely plain-HTTP LAN testing without Tailscale, override `COOKIE_SECURE=false` in `docker/aktenraum-api.env`. The runbook discourages this — it's a footgun.

### 3. ADR-005 supersedes ADR-002's near-term work, but doesn't replace ADR-002

ADR-002 is "Accepted" and stays Accepted. The Tauri desktop app is still the buyer-facing distribution. ADR-005 narrows the sequencing: the Tauri Phase 0 self-bootstrapping compose work is paused until concrete validation milestones are met. Listed in ADR-005:

- The maintainer has used aktenraum daily, primarily via remote access (Tailscale), for at least 30 calendar days.
- The intake pipeline (extraction → propagation → RAG indexing) has processed at least 200 real documents.
- The maintainer has identified at least one buyer (themselves not counted) willing to pre-pay or wait-list — i.e., evidence the product is worth packaging.
- The RAG eval `recall@5` on the maintainer's golden questions is ≥ 0.7 (current target floor — to be re-evaluated against actual measurements).

These criteria are deliberately falsifiable; the deferral isn't open-ended. ADR-005 also describes what un-deferring looks like (Phase 0 work resumes from where it paused; nothing is deleted or re-planned).

The ADR cross-link goes both ways: ADR-002's status becomes "Accepted (deferred — see ADR-005)" via a one-line edit; ADR-005 references ADR-002 in its Context.

### 4. The runbook prescribes one path, with two clearly-marked branches

The runbook is short by design — long runbooks rot. It walks the maintainer through:

1. Install Tailscale on the host machine (macOS app / Linux package).
2. `tailscale up` (interactive auth in browser; takes 1 click on a logged-in Tailscale account).
3. Verify `tailscale status` shows the host with an IP and a MagicDNS name.
4. Run `tailscale serve --bg --https=443 http://localhost:8080` (or `http://localhost:${AKTENRAUM_WEB_PORT}` if overridden).
5. Verify `tailscale serve status` lists the mapping.
6. Install Tailscale on phone + second laptop, log in to the same tailnet.
7. From a tailnet device, visit `https://<host-machine-name>.<tailnet>.ts.net/`.
8. Log in. The runbook ends.

Two branches off the main path:

- "Linux host without GUI" — uses `sudo apt install tailscale` and points at the alternative Tailscale Docker-sidecar pattern (sketched but not the default).
- "I want to share with a household member" — links to Tailscale's user-sharing docs; flagged as multi-user being a separate aktenraum concern.

Failure-mode appendix at the end of the runbook covers: MagicDNS off (HTTPS works but the URL doesn't resolve — flip the toggle in Tailscale admin), ACL blocking (tailnet policy needs to permit the device subset), cookie not sent (the `COOKIE_SECURE` footgun above).

### 5. No CSRF middleware, nginx, or aktenraum-api code change

The middleware code already passes same-origin requests, and the SPA at `https://aktenraum.<tailnet>.ts.net/` calling `/api/...` IS same-origin. The CSRF docstring already mentions Tailscale by name. Verified by re-reading `services/aktenraum-api/src/aktenraum_api/middleware.py` end-to-end.

nginx's `server_name _;` accepts any Host header, so MagicDNS hostnames don't need to be added to a whitelist.

The aktenraum-api cookie code uses the `secure` keyword from `settings.cookie_secure`, which is already True by default. No code change.

If a future requirement emerged to restrict accepted Host headers (defence-in-depth against host-header injection), that's a separate change — out of scope here.

### 6. `.env.example` gets one comment block; no env-file value changes

The aim is to be discoverable without surprising the maintainer. The existing `COOKIE_SECURE=false` line in `docker/aktenraum-api.env` (set for localhost dev) stays as-is. The `.env.example` gets a multi-line comment ABOVE the COOKIE_SECURE line, explaining:

- Default is `true`: required when accessed via Tailscale or any HTTPS edge.
- Localhost-dev override is `false`: required for plain `http://localhost:8080` because browsers refuse `Secure` cookies over insecure transport.
- Do NOT set `false` for the Tailscale path — see the runbook.

That comment is the discovery path: a maintainer encountering the "silent 401 loop" symptom searches for `COOKIE_SECURE` and the comment tells them why.

### 7. `Taskfile.yml` gains two minor shortcuts

`task tailscale:serve` runs `tailscale serve --bg --https=443 http://localhost:${AKTENRAUM_WEB_PORT:-8080}`. `task tailscale:status` runs `tailscale serve status`. These are conveniences — the maintainer can run the raw commands. The tasks exist to make the runbook copy-pasteable into a tab-completed Taskfile reference, and to ensure the port-override path stays consistent with `AKTENRAUM_WEB_PORT`.

## Risks / Trade-offs

- **[Host machine sleeps / shuts down → app becomes unreachable]** → Mitigation: documented as an operational expectation (the chosen machine should be one that stays on most of the time — Mac mini, NUC, desktop). The runbook tells the maintainer "if you pick a laptop that sleeps when closed, plan to leave it open + plugged in". This is intrinsic to the home-server topology; if it becomes a deal-breaker the answer is option 3 (VPS) which we deliberately rejected.

- **[Tailscale control plane outage → MagicDNS doesn't resolve, can't reach the URL]** → Mitigation: Tailscale's data plane is peer-to-peer (WireGuard direct), so an outage of their coordination server doesn't immediately break existing connections. New device-joins do break during the outage. Acceptable risk for the testing phase; not load-bearing.

- **[Maintainer adds a household member and their device shares the same login]** → Mitigation: documented as a known limitation in the runbook. ADRs / specs do not solve multi-user; that's a separate change when needed.

- **[`tailscale serve` config drifts on host reboot]** → Mitigation: the `--bg` flag installs the config as a system service that persists across reboots. Verified by Tailscale docs; runbook step 5 has the maintainer reboot once during setup to confirm.

- **[Tailscale-issued TLS cert revoked / expires]** → Mitigation: Tailscale auto-renews via the control plane (similar to Let's Encrypt automation). Not an action item for the maintainer.

- **[The cookie-not-sent failure mode is subtle and bounces users to login indefinitely]** → Mitigation: the runbook's failure-mode appendix and the `.env.example` comment cover this. CLAUDE.md gets a gotchas-table row. Documented in three places; if the maintainer hits it, search hits any of them.

- **[ADR-002 status change confuses future readers]** → Mitigation: ADR-002's one-line status update points directly at ADR-005; ADR-005's Context section quotes the relevant paragraph from ADR-002. A reader landing in either ADR sees the cross-link.

- **[The maintainer doesn't actually use it from mobile and the validation insight isn't gained]** → Mitigation: out of scope for this change. We can deliver remote access; we can't make the maintainer use it. If the next session's retro shows zero mobile sessions, the answer is to revisit the product use case, not the topology.

- **[Tailscale "serve" feature renamed or deprecated]** → Mitigation: low likelihood (it's a stable feature). If it happens, the runbook becomes a stub with a "see latest Tailscale docs" pointer.

## Migration Plan

This change is mostly additive (new runbook, new ADR, new Taskfile entries, one .env.example comment). The migration is documentation-first, with a smoke-test loop:

1. **ADR-005 lands** — `docs/adr/005-test-phase-access-via-tailscale.md` written. ADR-002 status line updated to point at it. One commit.
2. **Runbook lands** — `docs/runbooks/tailscale-remote-access.md` written with the eight-step main path, two branches, and the failure-mode appendix. Same commit as ADR-005 or the next one (small-change discipline).
3. **`.env.example` comment** — `docker/aktenraum-api.env.example` gets the multi-line comment above `COOKIE_SECURE`. Same commit as the runbook.
4. **Taskfile entries** — `task tailscale:serve` and `task tailscale:status` added. Verified via `task --list`. Same commit as the runbook.
5. **CLAUDE.md update** — implemented-vs-planned row added; gotchas-table row added (the cookie footgun); ADR-005 pointer line added to the "Distribution direction" block. Same commit.
6. **Live smoke test** — maintainer runs the runbook end-to-end on their actual host machine, accesses aktenraum from their phone, logs in, opens a doc, runs an /ask query. If any step fails, the runbook is the bug, not the code.
7. **Session note** — `docs/sessions/2026-05-21.md` records what shipped, link to ADR-005, and the smoke-test outcome.

Rollback: `tailscale serve --remove` on the host stops the proxy; nginx continues to serve only on `127.0.0.1:8080`. Revert the commits for the documentation cleanup. Zero data-migration concerns.

## Open Questions

- **Should `task tailscale:serve` also `tailscale up` if the daemon isn't joined?** Lean no — `tailscale up` is interactive (opens a browser for OAuth), wrapping it in a Taskfile entry obscures that interactivity. The runbook walks the maintainer through it once; the Taskfile only handles the `serve` part.
- **Does the runbook commit a sample `tailscale serve` config file (the JSON dump tailscale writes to `/var/lib/tailscale/serve.conf`)?** Lean no — the file is host-state, not configuration to be checked in; documenting the CLI invocation is enough.
- **What happens to `docs/plans/desktop-app.md` while ADR-005 is in effect?** Lean: keep the file unchanged. The plan is paused, not deleted. Adding a one-line header "PAUSED per ADR-005, planned to resume after milestones X/Y/Z" surfaces the state without rewriting the roadmap.
- **Do we want a `tailscale serve --remove` shortcut in the Taskfile?** Defer — operators run it once if they want to disable remote access; not worth a shortcut. Document the raw command in the runbook's "rolling back" section instead.
- **Is the cookie-not-sent failure visible in the API logs?** Worth checking: a missing cookie would produce a 401 on `/api/auth/me`, which is logged. The logs would let the maintainer self-diagnose. If logging isn't sufficient, the failure-mode appendix is the primary documentation path; no log-change needed.
