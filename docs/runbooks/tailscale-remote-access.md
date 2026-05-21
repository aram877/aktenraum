# Remote access via Tailscale (testing-phase topology)

**Time to complete**: ~15 min for first-time setup, ~25 min if you hit one failure mode.
**Pre-requisite**: aktenraum compose stack already running on the host machine (`task ps` shows all 10 containers healthy).
**Outcome**: you can reach aktenraum at `https://<host-machine-name>.<tailnet>.ts.net/` from any device you join to your Tailscale tailnet (phone, second laptop), over end-to-end-encrypted WireGuard. No public-internet exposure.

For the rationale behind this topology (why Tailscale over VPS / Cloudflare Tunnel / Tauri-now), see [ADR-005](../adr/005-test-phase-access-via-tailscale.md).

---

## Phase A — Get the host ready

The host is the machine that will run the compose stack 24/7 and proxy aktenraum into the tailnet. Pick one that stays powered on.

1. **Confirm the host is the right machine.** It needs to stay powered on and awake when you want to access aktenraum remotely.
   - **Windows**: `Settings → System → Power & battery → Screen and sleep` → set `When plugged in, put my device to sleep after` to **Never**.
   - **macOS**: `System Settings → Lock Screen` → set `Turn display off on power adapter when inactive` to **For 1 hour** or **Never**; `System Settings → Energy` → check **Prevent automatic sleeping on power adapter when the display is off**.
   - **Linux**: `systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target` (server-style), or set the desktop environment's power settings equivalent.
   - **If this is your daily-driver laptop and you close the lid frequently, this strategy won't work** — pick a desktop / mini-PC / NUC instead. Or accept that aktenraum is offline when the lid is closed.
2. **Confirm Docker Desktop / Docker Engine is set to auto-start on boot.**
   - **Windows**: `Docker Desktop → Settings → General → Start Docker Desktop when you sign in to your computer` (checked).
   - **macOS**: same path; same checkbox.
   - **Linux**: `sudo systemctl enable docker` (and `containerd` if it's separate).
3. **Confirm aktenraum is up and healthy.** From a terminal in the repo:
   ```
   task ps
   ```
   All 10 services should show as `running`. Visit `http://localhost:8080` (or `http://localhost:${AKTENRAUM_WEB_PORT}` if you overrode the port) in a browser **on the host itself**. Login screen should load.
4. **Create a Tailscale account.** Skip if you already have one. https://login.tailscale.com/start → sign in with Google / Microsoft / GitHub. The personal plan is free for up to 100 devices and is sufficient for this topology.

---

## Phase B — Install Tailscale on the host

5. **Download and install Tailscale.**
   - **Windows**: https://tailscale.com/download/windows → install the MSI. Default options are fine.
   - **macOS**: https://tailscale.com/download/mac → install the App Store version (recommended) or the standalone build.
   - **Linux**: follow the [official one-liner](https://tailscale.com/download/linux) (`curl -fsSL https://tailscale.com/install.sh | sh`).
6. **Sign in.**
   - **Windows / macOS**: click the system-tray Tailscale icon → `Log in...` → sign in with the same account from step 4.
   - **Linux**: `sudo tailscale up` — opens an auth URL in your terminal; visit it in any browser on any device that has your Tailscale login, approve.
7. **Verify the host joined the tailnet.** Open a terminal:
   ```
   tailscale status
   ```
   You should see the host's Tailscale IP (something like `100.x.y.z`) and its MagicDNS name (e.g., `aktenraum-pc.tail-abcd.ts.net`). **Note the MagicDNS name** — it's the root of your access URL.
8. **Verify MagicDNS is on.** Open https://login.tailscale.com/admin/dns in a browser. The **MagicDNS** toggle should be **enabled**. If it's off, flip it on. HTTPS-via-MagicDNS does not work without this — you'll get cert warnings or DNS failures.

---

## Phase C — Expose aktenraum to the tailnet

9. **Run `tailscale serve`** to proxy port 8080 to the tailnet edge over HTTPS:
   - **Windows (PowerShell or Git Bash, as a normal user)**:
     ```
     tailscale serve --bg --https=443 http://localhost:8080
     ```
   - **macOS / Linux**:
     ```
     tailscale serve --bg --https=443 http://localhost:8080
     ```
   - If you've overridden `AKTENRAUM_WEB_PORT` in `docker/.env`, substitute that port (e.g., `http://localhost:9090`).
   - Once the change ships, the equivalent shortcut is `task tailscale:serve` from Git Bash, which reads `AKTENRAUM_WEB_PORT` automatically.
   - **`--bg` is critical.** It installs the proxy as a persistent service that survives reboots and terminal closes. Without it the proxy dies as soon as you close the shell.
10. **Verify the mapping**:
    ```
    tailscale serve status
    ```
    Should print something like:
    ```
    https://aktenraum-pc.tail-abcd.ts.net (tailnet only)
    |-- / proxy http://127.0.0.1:8080
    ```
11. **Smoke-test from the host browser**: open `https://<host-machine-name>.<tailnet>.ts.net/` (the hostname from step 7, prefixed with `https://`) in a browser on the host machine itself. You should see the aktenraum login. If you see a cert warning or a DNS failure, MagicDNS is misconfigured — go back to step 8.

---

## Phase D — Install Tailscale on your client devices

12. **Install Tailscale on each device you want to use aktenraum from.**
    - **iPhone / iPad**: App Store → "Tailscale" → install → log in with the same account from step 4.
    - **Android**: Play Store → same.
    - **Second laptop / desktop**: same installers from step 5.
13. **Confirm the client joined.** Open the Tailscale app on the device — the host machine should appear in the device list with its MagicDNS name.
14. **Open `https://<host-machine-name>.<tailnet>.ts.net/`** in the device's browser. Login screen should load. **Log in. Open a doc. Run a `/ask` query.** This is the moment the testing phase is officially live remote.

---

## Phase E — Reboot test (highly recommended)

15. **Reboot the host once.** Wait for it to come back up, log in to the OS, confirm Docker Desktop auto-started and aktenraum is healthy (`task ps`), then immediately try the Tailscale URL from your phone. This validates that:
    - `tailscale serve --bg` persisted across reboot (it should, automatically — that's what `--bg` does).
    - Docker Desktop's auto-start is correctly configured (from step 2).
    - Compose's `restart: unless-stopped` is bringing services back up (it is — defined in `docker/docker-compose.yml`).
    - If aktenraum isn't healthy after reboot: check `task logs SVC=<service-name>` for the failing service. Most likely cause is Docker Desktop didn't auto-start — revisit step 2.

---

## Branches off the main path

### Branch 1 — Linux host without GUI (headless server)

If your host is a headless Linux server (no desktop environment, SSH-only), the main path still works — step 6 uses `sudo tailscale up` which prints an auth URL you can visit from any browser-equipped device.

For a fully containerised alternative (no Tailscale install on the host OS, everything in Docker), see the [Tailscale Docker sidecar pattern](https://tailscale.com/kb/1282/docker). That pattern adds a `tailscale/tailscale` service to the compose stack and uses an auth key for non-interactive sign-in. It's not the default here because it (a) requires auth-key management (where do you store the key?) and (b) complicates startup ordering. Recommended only if you have a strong reason to avoid touching the host OS.

### Branch 2 — Share aktenraum with a household member

Tailscale supports inviting other people to your tailnet ([user-sharing docs](https://tailscale.com/kb/1084/sharing)). They install Tailscale on their device, join your tailnet, and can hit the same URL.

**Important caveat**: aktenraum currently has a single bootstrap user. A household member reaching the URL would log in as that same user — there's no per-person account. Multi-user aktenraum is a separate concern (a future change), unrelated to the remote-access topology. Until then, "shared access" means "shared login".

---

## Failure-mode appendix

### "I see a TLS certificate warning"

**Diagnostic**: visit the URL on the host machine itself. If the warning appears there too, MagicDNS is not on or the cert hasn't been issued yet.

**Remediation**:
1. Open https://login.tailscale.com/admin/dns, confirm **MagicDNS** is enabled (toggle on).
2. Confirm **HTTPS Certificates** is enabled (same admin page, separate toggle).
3. Re-run `tailscale serve status` — it should show `https://...` not `http://...`.
4. If still broken, `tailscale serve --remove` then re-run step 9 from scratch.

### "The URL doesn't resolve at all"

**Diagnostic**: from the client device, run a DNS lookup for `<host-machine-name>.<tailnet>.ts.net`. If it returns NXDOMAIN, MagicDNS is off on that client (each device needs MagicDNS enabled in its own Tailscale app settings) OR the device's local DNS is overriding Tailscale's resolver.

**Remediation**: in the client Tailscale app, ensure **Use Tailscale DNS** (or "MagicDNS") is enabled. On Windows, also check that the host firewall isn't blocking Tailscale's DNS service — the installer usually configures this correctly.

### "The phone sees the host in `tailscale status` but the URL hangs / times out"

**Diagnostic**: from the phone (or any device that joined the tailnet), the host appears in the Tailscale app's device list, `ping`-ing the host's Tailscale IP from a desktop client also works, but `https://<host>.<tailnet>.ts.net/` hangs or eventually times out. This is most often an ACL (Access Control List) rule blocking the client device from reaching the host.

**Root cause**: Tailscale's default ACL (`{"acls": [{"action": "accept", "src": ["*"], "dst": ["*:*"]}]}`) allows everything. But if anyone touched the ACL editor (https://login.tailscale.com/admin/acls) and saved a more restrictive policy, the host might be unreachable from a subset of devices. Tagged devices, user groups, and `autoApprovers` can all carve holes that look surprising.

**Remediation**:
1. Open https://login.tailscale.com/admin/acls — confirm the policy compiles without errors and that the source device (the phone) can reach the destination device (the host) on the proxied port. Tailscale's policy editor has a "Preview" pane that simulates source → destination connectivity per port.
2. If the ACL is custom, look for: `accept` rules that don't include the host's tag in `dst`, `tag:server` requirements the client lacks, or port allowlists (`:443`) that omit the Tailscale-serve port.
3. The minimal viable fix for personal use is to revert to the default `accept all` ACL until you understand which rule shape you actually want. Tailscale's policy is JSON — diff against the default in their docs.
4. After saving an ACL change, the new policy propagates within ~30 seconds; retry the URL.

### "Login appears to succeed, then every page bounces back to login"

**Diagnostic**: open browser DevTools → Network tab → log in. Note that the response sets a `Set-Cookie` header. Refresh the page. The next request should send the cookie back as `Cookie:` — if it doesn't, this is the `COOKIE_SECURE` footgun.

**Root cause**: `COOKIE_SECURE=true` (the default) tells the browser to only send the auth cookie over HTTPS. If you're accessing aktenraum at `http://<lan-ip>:8080` (plain HTTP), the browser refuses to send the cookie back even though the server set it. Login looks like it works, then every API call returns 401.

**Remediation**: use the Tailscale MagicDNS URL (`https://...`) instead. **Do not** flip `COOKIE_SECURE` to `false` in `docker/aktenraum-api.env` to "fix" this — that weakens security for no reason; the Tailscale HTTPS URL works correctly with the secure-cookie default. `COOKIE_SECURE=false` is reserved for genuine plain-HTTP localhost dev on the host itself.

### "I'm getting 'tailnet only' but the URL still 404s"

**Diagnostic**: `tailscale serve status` shows the mapping is there, but the URL returns 404. Likely your nginx isn't reachable from `tailscale serve`'s view of localhost.

**Remediation**: confirm `task ps` shows nginx as running. Confirm `curl http://localhost:8080` works on the host directly. If it doesn't, the compose stack is the issue, not Tailscale. If it does, double-check the port in your `tailscale serve` command matches `AKTENRAUM_WEB_PORT`.

### "I want to add a second client device but Tailscale says my tailnet is at the device limit"

The free personal plan caps at 100 devices, which is generous. If you hit this, you've added device-y things you no longer use — open https://login.tailscale.com/admin/machines and remove old machines.

---

## What NOT to do

These are footguns or threat-model widenings — explicitly out of scope for the testing phase.

- **Don't enable `tailscale funnel`**. That exposes the URL to the public internet, gated only by aktenraum's login. The threat model widens to "anyone on the internet can attempt credential brute-force". The current ADR-005 topology stays with `serve` (tailnet-only). If a public-internet endpoint becomes a real requirement later, that's a separate decision with its own ADR.
- **Don't run `tailscale serve` without `--bg`**. The proxy dies as soon as you close the terminal, and you'll wonder why the URL stops working after the next reboot.
- **Don't set `COOKIE_SECURE=false` to "fix" the cookie-not-sent symptom.** That symptom is caused by accessing aktenraum over plain HTTP. The fix is to use the Tailscale HTTPS URL, not to weaken the cookie security.
- **Don't bind nginx to a LAN IP** (e.g., editing `docker-compose.yml` to publish nginx on `0.0.0.0:8080`). The compose default of `127.0.0.1:8080` means only the host can reach nginx; `tailscale serve` proxies that from the tailnet edge. Binding to a LAN IP exposes aktenraum to your entire local network, defeating the perimeter.

---

## Rolling back remote access

To turn off Tailscale remote access entirely:

```
tailscale serve --remove
```

The compose stack continues to serve locally on `127.0.0.1:8080`. Tailscale itself stays installed and connected — `tailscale status` still shows the host in the tailnet — but the HTTPS proxy is gone, so the `<host-name>.<tailnet>.ts.net` URL no longer reaches aktenraum.

To go further and leave the tailnet entirely:

```
tailscale logout
```

Or uninstall Tailscale from the host OS. Both leave the compose stack untouched.

---

## When to revisit this topology

This is the **testing-phase** access strategy. It explicitly does not solve buyer-facing distribution — non-technical buyers will not configure tailnets. The Tauri desktop app (see [ADR-002](../adr/002-distribution-desktop-app.md), deferred per [ADR-005](../adr/005-test-phase-access-via-tailscale.md)) is the buyer-facing answer once product validation milestones are met.

If you're reading this and you've finished the validation phase, the next runbook to read is [`docs/plans/desktop-app.md`](../plans/desktop-app.md), which resumes from Phase 0.
