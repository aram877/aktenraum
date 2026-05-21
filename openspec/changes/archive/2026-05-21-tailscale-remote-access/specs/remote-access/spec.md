## ADDED Requirements

### Requirement: Remote-access topology uses Tailscale private mesh

The system SHALL be reachable from the maintainer's authorised devices via a Tailscale (WireGuard) mesh network terminated by `tailscale serve --https` on the host machine. It MUST NOT be exposed to the public internet by any documented path (no `tailscale funnel`, no host-firewall port-forward, no LAN-IP bind by default).

#### Scenario: Default access topology is private-mesh-only

- **WHEN** the maintainer follows the testing-phase remote-access runbook on a fresh host
- **THEN** the only documented URL that resolves to aktenraum from a remote device is `https://<host-machine-name>.<tailnet>.ts.net/`
- **AND** that URL is reachable only from devices joined to the same Tailscale tailnet
- **AND** the compose stack continues to bind nginx to `127.0.0.1:${AKTENRAUM_WEB_PORT}` (default 8080), not a public interface

#### Scenario: Public exposure is not a documented default

- **WHEN** the maintainer reads `docs/runbooks/tailscale-remote-access.md`
- **THEN** the runbook describes `tailscale serve` (private mesh) as the default
- **AND** `tailscale funnel` (public internet exposure) is either absent or explicitly called out as out-of-scope for the testing phase

### Requirement: HTTPS by default via Tailscale MagicDNS

When accessed via the Tailscale topology, the SPA SHALL be served over TLS terminated by Tailscale using a certificate issued from the Tailscale control plane. The runbook MUST NOT document a plain-HTTP variant of remote access.

#### Scenario: First load from a remote device uses HTTPS

- **WHEN** a maintainer's phone (joined to the tailnet) opens the runbook-prescribed URL
- **THEN** the connection scheme is `https://`
- **AND** the browser shows a valid TLS lock without certificate warnings

#### Scenario: Cookie-secure default holds

- **WHEN** the maintainer logs in via the Tailscale HTTPS URL with default `COOKIE_SECURE=true`
- **THEN** the auth cookie is issued with the `Secure` flag
- **AND** subsequent same-origin requests from the SPA send the cookie back successfully

### Requirement: Setup runbook is end-to-end and reversible

The system MUST ship a runbook at `docs/runbooks/tailscale-remote-access.md` that takes a maintainer from a clean host (no Tailscale installed) to a working remote-access setup, including verification steps and a documented teardown path.

#### Scenario: Runbook covers the eight-step main path

- **WHEN** a reader follows the runbook top-to-bottom on a host that has the compose stack running
- **THEN** the runbook covers: (1) Tailscale install on the host, (2) `tailscale up` interactive auth, (3) `tailscale status` verification, (4) `tailscale serve` invocation, (5) `tailscale serve status` verification, (6) Tailscale install on a remote device, (7) URL verification from the remote device, (8) aktenraum login from the remote device
- **AND** every step lists the exact command(s) or UI action(s) to perform
- **AND** the runbook estimates total wall-clock time at 15 minutes or less for a first-time setup

#### Scenario: Runbook documents rollback

- **WHEN** the maintainer wants to disable remote access
- **THEN** the runbook describes the single command (`tailscale serve --remove`) that reverts the host to its prior state
- **AND** the runbook confirms that the compose stack continues to serve locally on `127.0.0.1:${AKTENRAUM_WEB_PORT}` after rollback

#### Scenario: Runbook covers known failure modes

- **WHEN** the maintainer encounters a setup failure
- **THEN** the runbook's failure-mode appendix lists, at minimum: MagicDNS not enabled, ACL blocking the device, and the `COOKIE_SECURE` cookie-not-sent footgun
- **AND** each failure mode has a documented diagnostic ("how do I confirm this is what's happening") and remediation ("here's how to fix it")

### Requirement: Operational expectations are documented for the maintainer

The runbook AND ADR-005 SHALL state the operational assumptions that the testing-phase Tailscale topology relies on, so the maintainer can decide informedly whether they apply.

#### Scenario: Host-availability assumption is explicit

- **WHEN** the maintainer reads the runbook or ADR
- **THEN** at least one document states that the host machine should remain powered on / awake when remote access is needed
- **AND** the implications of a sleeping laptop, lid-closed laptop, or a desktop that hibernates are flagged

#### Scenario: Tailnet membership is the perimeter

- **WHEN** the maintainer reads ADR-005
- **THEN** the ADR makes explicit that the tailnet membership is the primary access control and that aktenraum's own login is the secondary line of defence
- **AND** the implications of inviting additional devices or users into the tailnet are described as a separate concern from aktenraum multi-user support

### Requirement: Existing aktenraum-api configuration accommodates the topology without code changes

The system SHALL NOT require modifications to the aktenraum-api CSRF middleware, the auth cookie handling, or the nginx server-name configuration in order to operate under the Tailscale topology. Any required adjustment MUST be expressible as an environment-variable change or a runbook step, not source-code change.

#### Scenario: CSRF middleware accepts the same-origin SPA request

- **WHEN** the SPA at `https://aktenraum.<tailnet>.ts.net/` issues a state-changing API call to `/api/...`
- **THEN** the request's `Sec-Fetch-Site` header is `same-origin`
- **AND** the CSRF middleware allows the request without code modification

#### Scenario: nginx accepts the Tailscale Host header

- **WHEN** a request arrives at nginx with `Host: aktenraum.<tailnet>.ts.net`
- **THEN** nginx routes it to the SPA / `/api/*` location blocks as it would for any other Host
- **AND** no `server_name` allowlist edit is required

### Requirement: Buyer-facing distribution work is sequenced behind validation milestones

ADR-005 SHALL record that ADR-002 (Tauri desktop app distribution) remains the accepted buyer-facing strategy but that its Phase-0 work is deferred until concrete validation milestones are met. The milestones MUST be falsifiable, not open-ended.

#### Scenario: ADR-005 enumerates falsifiable milestones

- **WHEN** a future reader opens `docs/adr/005-test-phase-access-via-tailscale.md`
- **THEN** the ADR lists at least three concrete, measurable conditions whose satisfaction would resume Tauri Phase-0 work (e.g. a duration of remote-access usage, a corpus size, an external validation signal, a RAG eval threshold)
- **AND** the conditions are specific enough that a reader can determine, by inspection of the system or the world, whether each one has been met

#### Scenario: ADR-002 cross-links to ADR-005

- **WHEN** a reader opens `docs/adr/002-distribution-desktop-app.md`
- **THEN** the ADR's status line points the reader at ADR-005 (e.g. "Accepted (deferred — see ADR-005)")
- **AND** the original ADR-002 content is not deleted or rewritten — only the status reference is updated
