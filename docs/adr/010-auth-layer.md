# ADR-010: Auth layer — passkeys, server-side sessions, principals, scopes, service credentials

**Status**: Accepted (2026-11-19; build in-house and remove passwords confirmed by the maintainer; WebAuthn spike done 2026-11-19, see "Spike results")

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
- **Recovery codes are mandatory**: 10 single-use codes generated at enrollment, stored hashed, shown once. Using one forces enrolment of a new passkey. They are not optional: the spike showed that the same browser setup can store a passkey device-bound (Windows Hello, gone with the PC) as easily as synced (Google Password Manager).
- **TOTP**: optional second fallback for members without a second passkey device. Not required.
- **Passwords are removed from normal login.** Existing installs: the current password works exactly once after the upgrade, only to enrol the first passkey and receive recovery codes; then password login is disabled for that member. (Rejected alternative: keep passwords, but only together with a mandatory second factor.)
- **First run without any credential**: `task setup` / first-run prints a one-time **setup link** (random token, 30 min, single use) that opens passkey enrolment for the bootstrap admin. Replaces `BOOTSTRAP_PASSWORD`.
- **Adding a member** (ADR-009): the household admin creates an invite link (single use, 7 days); the invitee enrols a passkey. **Amendment 2026-11-19 (OpenSpec `tenancy-members`)**: members are invited *before* passkeys exist (maintainer decision — sharing first). Until step 4 lands, an invitee redeems the link with a **username + password** (min. 8 characters, same rules as change-password); everything else (single use, 7 days, only the token hash stored, uniform 404, per-IP throttle) is as specified here. When step 4 lands, redemption switches to passkey enrolment and password members enrol a passkey on their next login, exactly like the existing admin's migration path. **Adding a device**: from a logged-in device ("Gerät hinzufügen" → cross-device passkey / QR), or with a recovery code.
- **PRF extension**: requested at registration where the authenticator supports it, so the cloud phase can derive a key-wrapping key from the passkey (ADR-009 encryption mapping). Nothing is derived or stored yet. The PRF output is stable per passkey but **different for every passkey**, so key material is wrapped once per passkey, not once per member.

**RP ID constraint (must be handled, see spike):** a passkey is bound to the WebAuthn relying-party ID (the domain). One registered on `localhost` does not work on `https://<host>.<tailnet>.ts.net`, and neither necessarily works inside the Tauri WebView. We will store the `rp_id` with every credential, allow a configured list (`WEBAUTHN_RP_IDS`, `WEBAUTHN_ORIGINS`), and show in the device list which address each passkey belongs to. Enrolling a second passkey per address is the documented path. **Passkeys never work via an IP address** (`127.0.0.1`, `http://192.168.x.x:8080`): browsers reject IP RP IDs (`SecurityError: invalid domain`, verified). LAN access by IP therefore has no passkey login; the supported addresses are `localhost` on the host and an HTTPS hostname (Tailscale MagicDNS) elsewhere.

### 3. Sessions: opaque, server-side, revocable

- The cookie holds an **opaque 256-bit random token**; the database stores only its SHA-256 hash. JWT sessions and the `pwf` fingerprint go away.
- Cookie: `httpOnly`, `SameSite=Lax`, `Secure` on HTTPS with the `__Host-` prefix; plain-HTTP localhost keeps today's `COOKIE_SECURE=false` path.
- `sessions` table: `id`, `token_hash`, `member_id`, `household_id`, `client_id`, `auth_method` (passkey / recovery / setup), `created_at`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`, `step_up_at`, `user_agent`, `ip`, `revoked_at`.
- Lifetimes (defaults, configurable): **idle 7 days, absolute 30 days** for a browser session. Sliding `last_seen_at` is written at most once per minute.
- **Device list** in `/settings`: every session and passkey, "this device" marker, revoke one, revoke all others. Each passkey shows its provider (from the AAGUID, e.g. "Windows Hello", "Google Password Manager", "iCloud-Schlüsselbund"), whether it is synced or bound to one device, and the address (RP ID) it belongs to.
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
| Tauri desktop shell | **Sign-in through the system browser** on every platform: the shell opens `http://localhost:8080/login` in the default browser, the passkey ceremony runs there, and the shell receives its session via OAuth code + PKCE (loopback redirect), refresh token in the OS keychain. One code path for Windows, macOS and Linux. Passkeys inside the WebView work only on Windows (WebView2 on `http://localhost`, verified); macOS WKWebView needs Associated Domains for a real domain and WebKitGTK has no WebAuthn, so the in-WebView path is at most a Windows optimisation | with the shell |
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

### Spike results (2026-11-19)

Harness: `scripts/spikes/webauthn/` (Node + `@simplewebauthn/server`, test page, WebView2 window via pywebview). Host: Windows 11 25H2 build 26200.9974, Chrome 157, WebView2/Edge 157.

| Test | Result |
| --- | --- |
| Chrome on `http://localhost:8790` | ✅ Register + sign in twice, user verification required. Chrome stored the passkey in **Google Password Manager** (`multiDevice`, backed up, transports `hybrid`/`internal`) |
| WebView2 window on `http://localhost:8790` | ✅ Register + sign in. Stored in **Windows Hello** (`singleDevice`, not backed up) — WebView2 can serve as a passkey-capable shell on Windows |
| PRF | ✅ On both: 32-byte output at creation and every sign-in, identical per credential (Chrome `854bbb…` ×3, WebView2 `87599d…` ×2), different between credentials |
| `http://127.0.0.1:8790` | ❌ as expected — `SecurityError: This is an invalid domain` both with the IP as RP ID and when asserting RP ID `localhost` |
| Phone (hybrid / QR) | Not run (no change expected; standard WebAuthn) |
| Tailscale HTTPS hostname | Not run — Tailscale is not installed on this host |

Research (no local test possible): macOS WKWebView supports WebAuthn only for RP IDs the app is associated with (Associated Domains + `apple-app-site-association`), which `tauri://localhost` cannot satisfy; WebKitGTK (Linux) exposes no WebAuthn at all; native plugins (`tauri-plugin-passkey`) still need a signed macOS app with Associated Domains. Hence system-browser sign-in for the desktop shell.

### As built (`auth-server-sessions`, 2026-11-20 — step 4, first half)

Step 4 was split in two (maintainer decision 2026-11-20): this half ships server-side sessions, the device list, persisted rate limits and the auth audit with password login unchanged; `auth-passkeys` adds passkeys, recovery codes, the setup link, password retirement and step-up on top of the same tables.

- **Tables** (`schema.sql`, created by `applySchema`): `sessions` (`token_hash` = sha256 hex of the cookie token, unique; `member_id`, `household_id`, `client_id` `'spa'`, `auth_method`, `created_at`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`, `step_up_at`, `user_agent`, `ip`, `revoked_at`, `revoked_reason`), `auth_rate_limit_events` (`key`, `at`), `auth_audit` (`event`, `member_id`, `actor_member_id`, `session_id`, `username`, `reason`, `ip`, `user_agent`; no foreign keys). The `auth_method` CHECK already allows `passkey` / `recovery` / `setup` and `step_up_at` exists, because `applySchema` can't widen a CHECK or add a column later.
- **Cookie**: 32 random bytes, base64url (43 chars); only the hash is stored. `__Host-aktenraum_session` (`Secure`) with `COOKIE_SECURE=true`, `aktenraum_session` otherwise; `httpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` = `SESSION_ABSOLUTE_DAYS` (the server decides expiry). Login and logout also clear the other name, so an old JWT cookie doesn't linger.
- **Lifetimes**: `SESSION_IDLE_DAYS` (7) after last use, `SESSION_ABSOLUTE_DAYS` (30) after login. Use slides the idle expiry at most once a minute, never past the absolute one (`CASE`, not `least()`, so pg-mem runs it). Every comparison is made by the database clock.
- **Resolution**: `AuthGuard` → `SessionService.resolve` (one query: active session ⋈ member ⋈ user) → `TenancyService.resolveMember` (removed-member filter stays as a second line). The principal carries `sessionId` (= `sessions.id`) and `authTime` (= `created_at`).
- **Revocation reasons**: `logout` (POST `/auth/logout`, unguarded, no-op for unknown cookies), `user` (the member revokes the current session in the device list), `other_device` (`DELETE /auth/sessions/:id` of another own session, `POST /auth/sessions/revoke-others`), `password_change` (every session of the member), `member_removed` (lockout step of `MemberRemovalService.remove`, actor = the admin). Another member's session id → 404.
- **Streams**: `EventsController` checks `SessionService.state(sessionId)` each 3 s tick and ends with `event: session_ended` / `data: revoked|expired` (a removed member's session counts as revoked). Fixes finding E.
- **Rate limits** (`AuthRateLimiter`): keys `login:user:<lowercased name>`, `login:ip:<address>`, `invite:ip:<address>`; throttled at ≥ 10 events in 15 min (either login key); a failure records both login keys, success resets only the username key. `Retry-After` = until the oldest counted event leaves the window, from `min(at) + interval` and `now()` read in one query.
- **Client address**: `app.set("trust proxy", 1)` — `request.ip` is the right-most `X-Forwarded-For` entry nginx appends. Limitation: every request that reaches nginx through `tailscale serve` arrives from the same local address, so tailnet devices share one per-address bucket (no worse than before, when every request had nginx's address).
- **Audit**: `login_succeeded`, `login_failed` (attempted username), `login_throttled`, `logout`, `session_revoked` (one row per session, actor + reason), `password_changed`, `invite_redeemed`; best effort. No UI yet.
- **Sweep** (`AuthSweepService`, startup + hourly): sessions revoked/expired > 30 days, rate-limit events > 1 day, audit rows > 180 days.
- **Retired**: `auth/jwt.ts`, the `pwf` password fingerprint, `jsonwebtoken`, `JWT_SECRET`, `JWT_EXPIRES_SECONDS`, the in-memory `LoginThrottle`.
- **Rollback**: revert the code. `JWT_SECRET` is still in existing `docker/.env` files, so the old api starts; every device logs in once more; the three tables stay unused. (New installs from `.env.example` have no `JWT_SECRET` — a rollback there needs one generated: `openssl rand -base64 32`.)

### As built (`auth-passkeys`, 2026-11-21 — step 4 complete)

Passkeys are the login; passwords only lead to enrolling one. Built on the `auth-server-sessions` tables.

- **Seven tables** (`schema.sql`, `applySchema`): `webauthn_users` (random 64-byte user handle per member, never the member id), `passkeys` (credential id, COSE public key, sign count, transports, AAGUID, `singleDevice`/`multiDevice`, backed up, PRF available, RP ID, name, last use, `removed_at`), `webauthn_challenges` (one row per begun ceremony, 5 minutes, claimed exactly once with `UPDATE … WHERE used_at IS NULL AND expires_at > now() RETURNING`), `recovery_codes` (sha256 of the normalised code, batch, used / invalidated), `setup_tokens` (sha256, 30 minutes, `created_by_member_id` NULL = host), `password_retirements` (a row = password login off; the hash stays), `credential_audit` (no CHECK on `event`, no foreign keys).
- **Ceremonies** (`auth/webauthn.service.ts`, `@simplewebauthn/server` 13): begin checks `Origin` ∈ `WEBAUTHN_ORIGINS` (400 before any row), RP ID = the origin's host name (never a header); UV and resident keys required, attestation `none`, PRF requested (only its availability is recorded); finish claims the row first, so a failed verification still spends it. Authentication checks the stored user handle, refuses removed passkeys and removed members, updates the sign count and refuses a regression on a non-zero counter. One 401 body for every failure.
- **Restricted sessions** (design §4): `password` / `recovery` sessions and members without an active passkey get only `auth:enrol`; `authorize()` answers 403 `enrolment_required` on every route without `@AllowRestricted()` — checked before scopes, so a forgotten marker fails closed. Allowed: `GET /auth/me`, `POST /auth/passkeys/register/begin|finish`.
- **Enrolment** (`auth/enrolment.service.ts`): passkey → recovery codes if none unused → retirement row → revoke the member's `password` sessions (`password_change`) and the enrolling recovery session (`user`) → a **new** `passkey` session with `step_up_at = now()` (no fixation). `AuthService.authenticate` answers a retired member like a wrong password (after bcrypt, counted). `verifyPassword` returns false for non-bcrypt input; passwordless members carry `password_hash = '!'`. `POST /auth/change-password` is gone.
- **Recovery codes**: 10 × 16 Crockford base32 (80 bits), `XXXX-XXXX-XXXX-XXXX`, normalised on input, unpeppered sha256 (80 bits defeats offline search). `POST /auth/recovery` → restricted `recovery` session; limits `login:user` + `login:ip`; unknown names run the same claim against nobody.
- **Setup links**: first run (passwordless bootstrap admin), household admin (`POST /household/members/:id/setup-link`, step-up, revokes earlier unused links), host CLI (`node dist/auth/setup-link-cli.js <user>`, `task setup-link`). Using one: passkey + a new recovery set + a full `setup` session; other sessions stay (the success page links to the device list).
- **Invites** enrol a passkey: `/invites/:token/register/begin|finish`; the invite is claimed only after a verified ceremony.
- **Step-up** (`@RequireStepUp()`, 5 min, SQL): trash empty / permanent delete, passkey rename / remove / add, recovery-code regeneration, invites, setup links, member removal, shared-space deletion and membership, LLM models, auto-approve. `POST /auth/step-up/begin|finish` with the caller's own passkey; failures count on `login:ip` and are audited. Passkey, setup and invite sign-ins count as a confirmation. The SPA's `useApi` asks for the passkey and repeats the request once.
- **Audit**: passkey / recovery logins in `auth_audit` (`reason` = method); everything else in `credential_audit`. The sweep also prunes challenges (> 1 day expired), setup tokens (> 30 days), spent recovery codes and credential audit (> 180 days).
- **Rollback**: revert the code. Members who had a password before keep it (the hashes were never touched) and log in as before. Members created without one (invites, a passwordless first run) have `password_hash = '!'` — give them a temporary password first, e.g. `docker compose exec aktenraum-api node -e "import('bcryptjs').then(b=>b.default.hash('<temp>',12)).then(console.log)"` and `UPDATE users SET password_hash = '<hash>' WHERE username = '<name>'`. The seven tables stay unused.

### As built (`service-credentials`, 2026-11-21 — step 5)

`WEBHOOK_SECRET` / `X-Aktenraum-Secret` are gone; each internal caller has its own credential.

- **Credentials**: `SVC_TOKEN_PAPERLESS_HOOK`, `SVC_TOKEN_WORKER`, `SVC_TOKEN_API` in `docker/.env`, generated by `bootstrap-secrets.sh` as `akt_svc_` + base64url of 32 random bytes (the prefix keeps them apart from future `akt_pat_` tokens and makes leaks recognisable). Sent as `Authorization: Bearer <value>`. Any non-empty value is accepted; shorter than 32 characters logs `service_token_weak`.
- **One helper** (`@aktenraum/core` `secrets.ts`): `serviceCaller(authorization, credentials)` parses exactly `Bearer <value>` (scheme case-insensitive, one space, no array), compares against every configured credential with `secretMatches` (no early exit) and returns the single matching name. Values shared by two credentials are dropped first, so a duplicate fails closed. `checkServiceCredentials` / `logServiceCredentialCheck` → `service_token_unset` / `service_token_duplicate` / `service_token_weak` at startup (names only, never values) in both services.
- **Worker** (`webhook.ts`): instead of scopes, one table `ALLOWED` — `extract` ← `paperless-hook`, `api`; `propagate`, `reindex-metadata`, `processing` ← `api`. Unknown/missing credential → 401 `webhook_rejected reason=unknown_credential`; known caller outside its row (including the worker's own credential) → 403 `reason=not_allowed caller route`. `webhook_enqueued` carries `caller`. The section-7 scope names (`internal:trigger`, `internal:processing-read`) were not introduced — four routes didn't justify a vocabulary.
- **api** (`auth/internal.guard.ts`): `InternalGuard` / `UserOrInternalGuard` verify against `{worker, api}` and accept only `worker` → `workerPrincipal()` with the unchanged `WORKER_SCOPES`. The api's own token and anything else → 401 `Invalid credential`; the api never holds the hook token. `UserOrInternalGuard`: no `Authorization` header → session cookie; header present → worker credential or 401, never a cookie fallback. `AutoTaggerClient` sends `SVC_TOKEN_API`.
- **Per-container** (`docker-compose.yml`, `environment:` overrides `env_file`): Paperless gets the hook token as `AKTENRAUM_HOOK_TOKEN` and blank `SVC_TOKEN_*`; the api blank hook token; backup none. `post_consume.sh` sends the bearer header.
- **Accepted**: the worker holds the hook and api tokens (whoever verifies a shared secret holds it), and every container still sees the rest of `.env` (Paperless superuser token, DB password) — §8.
- **Rollback**: check out the previous commit and `task build`. `WEBHOOK_SECRET` is still in existing `.env` files (`bootstrap-secrets.sh` no longer generates it but never deletes it); the `SVC_TOKEN_*` lines are ignored by the old code. New installs from `.env.example` have no `WEBHOOK_SECRET` — generate one (`openssl rand -base64 32`) before rolling back there.

### Open points

- Re-run the harness on a Mac (Safari; later a signed Tauri build) and against an HTTPS hostname via Tailscale; try phone hybrid enrolment.
- Session lifetimes are built as 7 d idle / 30 d absolute (configurable); the step-up list is pinned by `test/route-inventory.test.ts` — review after real use.
- Whether to wipe `users.password_hash` (dropping the rollback path) after a few weeks of passkey-only use.
- Whether TOTP is worth its UI cost or recovery codes + a second passkey are enough.
