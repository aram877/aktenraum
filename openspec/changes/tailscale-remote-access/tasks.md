## 1. ADR-005 + ADR-002 cross-link

- [x] 1.1 Write `docs/adr/005-test-phase-access-via-tailscale.md` using `docs/adr/000-template.md` as the structure. Sections: Status (Accepted), Context (quote the relevant paragraph from ADR-002 and explain why Tauri Phase-0 is the wrong work for the testing phase), Decision (Tailscale `serve` on host is the testing-phase access topology; Tauri ADR-002 stays Accepted but is deferred), Consequences (what this enables for validation; what it constrains; what it doesn't replace), Milestones for un-deferring Tauri (at least 3 concrete falsifiable conditions per the spec).
- [x] 1.2 Edit `docs/adr/002-distribution-desktop-app.md`: change the Status line from `**Status**: Accepted` to `**Status**: Accepted (deferred — see ADR-005)`. Do not delete or rewrite any other content.
- [x] 1.3 Verify cross-link: ADR-005 references ADR-002 in its Context; ADR-002's status line points at ADR-005. Both files compile (markdown lint pass).

## 2. Runbook

- [x] 2.1 Write `docs/runbooks/tailscale-remote-access.md` with the eight-step main path: install Tailscale on host, `tailscale up`, `tailscale status`, `tailscale serve --bg --https=443 http://localhost:${AKTENRAUM_WEB_PORT:-8080}`, `tailscale serve status`, install Tailscale on a remote device, visit `https://<host-machine-name>.<tailnet>.ts.net/`, log in.
- [x] 2.2 Add the two branches: "Linux host without GUI" (apt install + interactive `tailscale up`; mention the Tailscale Docker sidecar as alternative without making it the default), "Share with a household member" (link to Tailscale's user-sharing docs; flag that aktenraum multi-user is a separate concern).
- [x] 2.3 Add the failure-mode appendix: MagicDNS off → fix in Tailscale admin; ACL blocking → diagnostic + remediation; cookie-not-sent footgun (`COOKIE_SECURE=true` + plain `http://lan-ip` → cookie set but never sent → infinite login bounce) → diagnostic (DevTools showing cookie set but not sent) + remediation (use MagicDNS hostname).
- [x] 2.4 Add a "Rolling back remote access" section near the bottom with the single command `tailscale serve --remove` and a one-sentence statement that the compose stack continues to serve locally afterwards.
- [x] 2.5 Estimate wall-clock setup time in the runbook header (target: ≤ 15 minutes).

## 3. `.env.example` documentation

- [x] 3.1 Add a multi-line comment block above the `COOKIE_SECURE` line in `docker/aktenraum-api.env.example` explaining the three scenarios: localhost dev (`false`), Tailscale HTTPS (`true` — default), the footgun (do not flip to `false` when accessing via Tailscale).
- [x] 3.2 Confirm `docker/aktenraum-api.env` is NOT modified by this task — only the `.example` file. Local dev keeps its explicit override.

## 4. Taskfile shortcuts

- [x] 4.1 Add `tailscale:serve` target to `Taskfile.yml` that runs `tailscale serve --bg --https=443 http://localhost:${AKTENRAUM_WEB_PORT:-8080}`. Include a `desc:` line that surfaces in `task --list`.
- [x] 4.2 Add `tailscale:status` target that runs `tailscale serve status`. Same `desc:` discipline.
- [x] 4.3 Verify `task --list` shows both new entries with their descriptions.

## 5. CLAUDE.md updates

- [x] 5.1 Add a new row to the "What's implemented vs planned" table: feature = `Remote access via Tailscale (testing-phase topology)`, status = `✅ Runbook + ADR-005 — see docs/runbooks/tailscale-remote-access.md`.
- [x] 5.2 Add a new row to the "Known gotchas" table: issue = `Login appears to succeed but every API call returns 401 — auth cookie set but never sent`, fix = `Cause is `COOKIE_SECURE=true` (default) combined with plain-HTTP access (typically `http://<lan-ip>:8080`). The browser refuses to send `Secure` cookies over plain HTTP. Use the Tailscale MagicDNS HTTPS URL instead, or set `COOKIE_SECURE=false` ONLY for genuine plain-HTTP localhost dev`.
- [x] 5.3 In the "Distribution direction (binding)" block, add a one-sentence reference to ADR-005 noting that Tauri Phase-0 is deferred while the maintainer validates the product via Tailscale-mediated remote access.
- [x] 5.4 Keep all existing CLAUDE.md content; the edits are additive except for the one-sentence insertion in the Distribution-direction block.

## 6. Verification

- [x] 6.1 `uv run pytest` from the repo root — full Python suite passes, confirming nothing in the documentation-only change inadvertently broke imports / config validators.
- [x] 6.2 `pnpm --filter @aktenraum/web build` succeeds, confirming the SPA still builds.
- [x] 6.3 `task --list` shows the new Tailscale tasks with their descriptions.
- [ ] 6.4 Live smoke test on the maintainer's host: follow the runbook end-to-end on the actual host machine, install Tailscale on phone, hit the URL, log in, open a doc, run one `/ask` query. Note observations in the session log.
- [x] 6.5 Diagnostic check for the cookie footgun: temporarily bind nginx to a LAN IP (or use port-forward), visit over plain HTTP, confirm the symptom matches what the runbook describes. Revert binding afterwards. (Optional — only if there's any doubt about the documented diagnostic.)

## 7. Session log + commit hygiene

- [x] 7.1 Write `docs/sessions/2026-05-21.md` (or the date of the implementation session) per the binding documentation cadence: what shipped, the smoke-test outcome, "things to pick up next session" (notably: revisit `docs/plans/desktop-app.md` to add a "PAUSED per ADR-005" header), ADR-005 link.
- [ ] 7.2 Stage the change as one or two commits (ADR + runbook + .env-example + Taskfile + CLAUDE.md update + session log). NEVER commit before `uv run pytest` and `pnpm --filter @aktenraum/web build` are both green per the project's commit discipline.
- [ ] 7.3 Push to `main` only after the maintainer confirms the smoke test on their own host machine succeeded (the runbook IS the implementation; if the smoke test fails, the runbook is the bug).
