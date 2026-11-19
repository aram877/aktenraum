# ADR-010: Auth layer — passkeys, server-side sessions, principals, scopes, service credentials

**Status**: Accepted (2026-11-19; build in-house and remove passwords confirmed by the maintainer; WebAuthn RP-ID spike pending)

**Date**: 2026-11-19

**Builds on**: [ADR-009](009-tenancy-households-spaces.md) (tenancy). **Related**: [ADR-002](002-distribution-desktop-app.md) (Tauri desktop), [ADR-003](003-csrf-defence.md) (CSRF), [ADR-005](005-test-phase-access-via-tailscale.md) (remote access via Tailscale).

## Context

### What exists today

- **Login**: one user seeded from `BOOTSTRAP_USERNAME` / `BOOTSTRAP_PASSWORD`, bcrypt password, per-username throttle (10 failures / 15 min, in memory).
- **Session**: stateless HS256 JWT in an httpOnly `SameSite=Lax` cookie, 8 h. A password fingerprint (`pwf`) in the token logs out other devices on password change. No way to revoke one device, no device list.
- **Request identity**: `AuthGuard` (`services/aktenraum-api/src/auth/auth.guard.ts`) sets `request.user: AuthUser = {id, username, passwordHash}`. No scopes, no session id, no client id; the password hash travels with the request.
- **Internal calls**: one `WEBHOOK_SECRET` (`X-Aktenraum-Secret`) shared by five callers and opening every internal endpoint plus the CSRF bypass.

### Audit findings (2026-11-19, read-only)

| # | Finding |
| --- | --- |
| A | `type-fields.controller.ts` `requireUserOrSecret` reads the cookie and calls `verifySession` itself, bypassing the guard. |
| B | `common/middleware.ts` skips CSRF for any request carrying the internal secret — internal identity and browser protection are tangled. |
| C | Four copies of the secret comparison (`middleware.ts`, `settings.controller.ts`, `type-fields.controller.ts`, worker `webhook.ts`). |
| D | `WEBHOOK_SECRET` callers: Paperless `post_consume.sh`, api → worker, worker → api (active model, auto-approve rules, type fields). Paperless's hook can call everything the worker can; callers are indistinguishable in logs. |
| E | The SSE live-counts stream authenticates once and never re-checks — a revoked session would keep streaming. |
| F | Worker `/processing` is secret-gated; the worker has no notion of a user. |

### Forces

- **Multiple members per household** (ADR-009) — the auth model must identify a member, not "the" user, and carry household/space context.
- **Several kinds of clients**: the SPA in a browser (localhost, LAN, Tailscale `*.ts.net`), the future Tauri desktop shell, scripts, a CLI, and AI agents / MCP clients that need delegated, scoped access.
- **Desktop product** (ADR-002): no heavy extra containers, idempotent first run, works offline on a single machine.
- **Later cloud storage / cloud analysis**: the identity layer must be able to produce key material for client-side encryption (ADR-009 encryption mapping).
- Passwords are phishable and reused; the maintainer explicitly wants something better than email + password, even for a local app.

## Decision

### 1. Build the auth layer inside aktenraum-api

We will implement auth in aktenraum-api with established libraries — `@simplewebauthn/server` for WebAuthn, and `oidc-provider` (panva, OpenID-certified) when the OAuth phase arrives — rather than run an external identity provider container.

- Why: the desktop footprint (Keycloak/Authentik are too heavy; even Zitadel/Ory add a service and a database), one process to deploy and back up, and the maintainer's goal of understanding auth and client integration from the inside for his new role.
- Rejected alternative: a lightweight external IdP (Pocket-ID, Zitadel, Ory Kratos + Hydra). Faster to a secure baseline, but another container, another upgrade path, and less learning. Revisit if the cloud variant needs federation (Google/Apple sign-in, enterprise SSO).

### 2. Identity: passkeys first

- **Passkeys (WebAuthn / FIDO2) are the primary login**: discoverable credentials, `userVerification: "required"`, attestation `none`. Several passkeys per member (phone, laptop, security key), each named and listed in the device page.
- **Recovery codes**: 10 single-use codes generated at enrollment, stored hashed, shown once. Using one forces enrolment of a new passkey.
- **TOTP**: optional second fallback for members without a second passkey device. Not required.
- **Passwords are removed from normal login.** Existing installs: the current password works exactly once after the upgrade, only to enrol the first passkey and receive recovery codes; then password login is disabled for that member. (Rejected alternative: keep passwords, but only together with a mandatory second factor.)
- **First run without any credential**: `task setup` / first-run prints a one-time **setup link** (random token, 30 min, single use) that opens passkey enrolment for the bootstrap admin. Replaces `BOOTSTRAP_PASSWORD`.
- **Adding a member** (ADR-009): the household admin creates an invite link (single use, 7 days); the invitee enrols a passkey. **Adding a device**: from a logged-in device ("Gerät hinzufügen" → cross-device passkey / QR), or with a recovery code.
- **PRF extension**: requested at registration where the authenticator supports it, so the cloud phase can derive a key-wrapping key from the passkey (ADR-009 encryption mapping). Nothing is derived or stored yet.

**RP ID constraint (must be handled, see spike):** a passkey is bound to the WebAuthn relying-party ID (the domain). One registered on `localhost` does not work on `https://<host>.<tailnet>.ts.net`, and neither necessarily works inside the Tauri WebView. We will store the `rp_id` with every credential, allow a configured list (`WEBAUTHN_RP_IDS`, `WEBAUTHN_ORIGINS`), and show in the device list which address each passkey belongs to. Enrolling a second passkey per address is the documented path.

### 3. Sessions: opaque, server-side, revocable

- The cookie holds an **opaque 256-bit random token**; the database stores only its SHA-256 hash. JWT sessions and the `pwf` fingerprint go away.
- Cookie: `httpOnly`, `SameSite=Lax`, `Secure` on HTTPS with the `__Host-` prefix; plain-HTTP localhost keeps today's `COOKIE_SECURE=false` path.
- `sessions` table: `id`, `token_hash`, `member_id`, `household_id`, `client_id`, `auth_method` (passkey / recovery / setup), `created_at`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`, `step_up_at`, `user_agent`, `ip`, `revoked_at`.
- Lifetimes (defaults, configurable): **idle 7 days, absolute 30 days** for a browser session. Sliding `last_seen_at` is written at most once per minute.
- **Device list** in `/settings`: every session and passkey, "this device" marker, revoke one, revoke all others.
- **Step-up**: sensitive actions require a passkey assertion within the last 5 minutes: emptying the trash / permanent delete, export, adding or removing passkeys or recovery codes, member and space management, creating personal access tokens, changing backup or LLM settings.
- **SSE** (finding E): long-lived streams re-check their session at least every 30 s (cached lookup) and close on revocation or expiry.
- **CSRF** (ADR-003) stays for cookie-authenticated requests. Requests authenticated by bearer or service credentials carry no cookie and are not subject to it.

### 4. One principal, one guard

Every authenticated request resolves to exactly one `Principal`:

```ts
type Principal =
  | { kind: "member"; memberId; householdId; householdRole; sessionId | tokenId; clientId; scopes; authTime; stepUpAt }
  | { kind: "service"; service: "worker" | "paperless-hook" | "api"; scopes };
```

- One `AuthGuard` resolves it from the session cookie, a bearer token, or a service credential — in that order — and nothing else reads cookies or secrets (fixes A, C).
- `@CurrentPrincipal()` replaces `@CurrentUser()`; `@RequireScopes(...)` and `@RequireStepUp()` decorate routes.
- The principal carries no secrets (no password hash).
- **Authorization stays in the ADR-009 `PolicyService`**: scopes say *what kind* of action a client may perform; the policy says *on which documents/spaces* the member may perform it. A request needs both.

### 5. Scopes

`documents:read`, `documents:write`, `documents:delete`, `upload`, `ai:ask`, `shares:manage`, `settings:read`, `settings:write`, `household:admin`. Internal-only: `internal:trigger`, `internal:settings-read`, `internal:type-fields-write`, `internal:processing-read`.

A browser session gets every scope the member's household role permits. Tokens and OAuth clients get an explicit subset chosen at creation / consent time.

### 6. Clients

| Client | Mechanism | Phase |
| --- | --- | --- |
| SPA (same origin, served by nginx) | Cookie session (backend-for-frontend; tokens never reach JS) | 1 |
| Tauri desktop shell | Same as SPA while the UI is served from a local origin; OAuth code + PKCE with the refresh token in the OS keychain once it talks to a remote/cloud instance | 1 / 3 |
| Scripts, integrations | **Personal access tokens**: `akt_pat_` + random, stored hashed, scoped, mandatory expiry (≤ 1 year), `last_used_at`, revocable, created behind step-up | 2 |
| CLI | OAuth device authorization grant (RFC 8628) | 3 |
| AI agents / MCP clients / third-party apps | OAuth 2.1 authorization server (`oidc-provider`): authorization code + PKCE only, consent screen listing scopes, refresh-token rotation, per-client revocation | 3 |

Phase 3 is decided here but built when a concrete client needs it; personal access tokens cover scripting until then.

### 7. Service-to-service credentials (replaces `WEBHOOK_SECRET`, fixes B–D, F)

- One credential **per caller**, generated by `scripts/bootstrap-secrets.sh`: `SVC_TOKEN_PAPERLESS_HOOK`, `SVC_TOKEN_WORKER`, `SVC_TOKEN_API`. Sent as `Authorization: Bearer`.
- Each maps to a fixed service principal and scope set:
  - paperless-hook → worker: `internal:trigger` (extract only)
  - worker → api: `internal:settings-read`, `internal:type-fields-write`
  - api → worker: `internal:trigger`, `internal:processing-read`
- The worker gains the same small guard (one comparison helper shared via `@aktenraum/core`).
- Fail-closed stays: a missing credential rejects the call and logs at startup, as `webhook_secret_unset` does today.
- Not mTLS: certificate management on Docker Desktop is disproportionate while the network is internal-only. Revisit for the cloud variant.
- The CSRF bypass keyed on the secret disappears; service calls are simply not cookie-authenticated.

### 8. Paperless credentials

Per ADR-009, user requests reach Paperless with the member's own Paperless token. Those tokens are stored **encrypted at rest** in the aktenraum database (AES-256-GCM, key from a new generated `AKTENRAUM_SECRET_KEY`), minted and rotated by aktenraum, never sent to the browser. The worker keeps the service-level `PAPERLESS_API_TOKEN`.

### 9. Abuse protection and audit

- Rate limits on login begin/finish, recovery-code use, setup and invite redemption — per credential and per IP, persisted in Postgres so a restart doesn't reset them.
- Auth events go to the ADR-009 audit log: login success/failure, passkey added/removed, recovery code used, session revoked, token created/used/revoked, step-up, invite created/redeemed.

### 10. Honest limits

On a self-hosted machine, whoever controls the host (Docker, the database, the disk) can read everything; member separation protects members from each other inside the app, not from the host administrator. Real protection against the host operator only comes with the client-side encryption of the cloud phase.

## Consequences

**Easier**

- Phishing-resistant login with no password to steal or reuse.
- Per-device revocation and a visible device list; a lost phone is one click.
- Every request has one principal; the four ad-hoc secret checks and the guard bypass disappear.
- Scripts and agents get narrowly scoped, revocable access instead of a full browser session.
- A compromised Paperless hook can only trigger extraction.
- The passkey PRF path prepares client-side encryption without committing to it.

**Harder**

- WebAuthn RP-ID handling across `localhost`, Tailscale hostnames and the Tauri WebView; members may need one passkey per address.
- More schema: `credentials` (passkeys), `recovery_codes`, `sessions`, `personal_access_tokens`, `invites`, `rate_limits`, `audit_log`; all added to both `schema.ts` and `schema.sql`.
- One forced re-login for everyone on upgrade (JWT cookies become invalid) and a one-time passkey enrolment per member.
- `docker/.env` gains `SVC_TOKEN_*`, `AKTENRAUM_SECRET_KEY`, `WEBAUTHN_RP_IDS`, `WEBAUTHN_ORIGINS`; `BOOTSTRAP_PASSWORD` and `WEBHOOK_SECRET` are retired. The upgrade runbook must cover the switch.
- Losing every passkey **and** every recovery code locks a member out; the household admin can issue a new setup link, and for a single-member household the last resort is a CLI reset on the host (documented, audited).
- Owning the security of a hand-built auth layer: it needs its own threat-model review and tests (rate limits, replay, session fixation, step-up bypass).

### Migration (existing install)

1. Deploy the schema; existing user becomes the household admin member (ADR-009 step 1).
2. First visit after the upgrade: old JWT rejected → login with the current password one last time → mandatory passkey enrolment + recovery codes → password login disabled.
3. `bootstrap-secrets.sh` generates `SVC_TOKEN_*` and `AKTENRAUM_SECRET_KEY`; services are recreated together so no caller is left on the old secret.
4. Second address (Tailscale): enrol a second passkey from there.

### Implementation order (each an OpenSpec change)

1. Pre-auth cleanup: one comparison helper, `type-fields` on guards, CSRF decoupled from internal identity (A–C).
2. `Principal` + `PolicyService` (still single member) — every check routed through them.
3. ADR-009 tenancy data model + migration.
4. Passkeys, recovery codes, server-side sessions, device list, step-up, SSE re-check (sections 2–3, finding E).
5. Service credentials replacing `WEBHOOK_SECRET` (section 7).
6. Personal access tokens (phase 2), then OAuth/device flow when a client needs it (phase 3).

### Open points

- **Spike**: WebAuthn on `http://localhost:8080`, `https://<host>.<tailnet>.ts.net` and inside a Tauri WebView2/WKWebView — RP IDs, PRF support, cross-device (hybrid) enrolment.
- Session lifetimes (7 d idle / 30 d absolute) and the step-up action list — defaults to review.
- Whether TOTP is worth its UI cost or recovery codes + a second passkey are enough.
