# Proposal

## Why

Since `auth-server-sessions` (live 2026-11-21) a login is a revocable server-side session, but it is still started with a username and password — phishable, reusable, and the only thing standing between a household's documents and anyone who guesses or reuses it. ADR-010 decided passkeys as the primary login and the removal of passwords (maintainer, 2026-11-19); the WebAuthn spike confirmed it works on `localhost` in Chrome and WebView2. This change is the second half of ADR-010 step 4: **passkeys, mandatory recovery codes, setup links, password retirement, passkey-based invites and step-up confirmation**, on top of the session tables that already reserve `auth_method` `passkey` / `recovery` / `setup` and `step_up_at`.

## What Changes

- **Passkey login** (WebAuthn, discoverable credentials, user verification required, attestation `none`): "Mit Passkey anmelden" on `/login`, no username needed. Several passkeys per member, each with a name, provider (from the AAGUID, e.g. "Windows Hello", "Google Passwortmanager", "iCloud-Schlüsselbund"), synced vs. device-bound, and the address (RP ID) it belongs to. The PRF extension is requested at registration and only its availability is recorded.
- **Allowed addresses**: `WEBAUTHN_RP_IDS` / `WEBAUTHN_ORIGINS` (defaults: `localhost`, `http://localhost:8080` + the dev server). A passkey works only on the address it was created on; the login page says so when opened on an address without passkeys (e.g. an IP address, where browsers refuse passkeys).
- **Recovery codes** (mandatory): 10 single-use codes created with the first passkey, stored hashed, shown once; regenerating invalidates the old set. Signing in with username + recovery code gives a session that can only enrol a new passkey.
- **Setup links** (single use, 30 minutes): the first run prints one for the bootstrap admin instead of a password; the household admin can issue one for a member who lost every passkey and code; a host-side CLI issues one as the last resort (single-member household). Using a link enrols a passkey and issues new recovery codes.
- **BREAKING — passwords retire**: an existing member's password works once more, only for a session restricted to enrolling a passkey; once a passkey and recovery codes exist, password login is off for that member. The password form leaves `/settings → Konto`; `POST /api/auth/change-password` is removed. `BOOTSTRAP_PASSWORD` is retired for new installs (`task login` → `task setup-link`).
- **BREAKING — invites enrol a passkey**: `/invite/<token>` asks for a username and creates a passkey instead of a password.
- **Step-up**: sensitive actions need a passkey confirmation within the last 5 minutes — emptying the trash / permanent delete, managing passkeys and recovery codes, invites and setup links, member removal, shared-space deletion and membership, LLM model and auto-approve settings. The SPA asks for the passkey and retries the action.
- **Konto page**: "Passkeys" (list, add, rename, remove — never the last one), "Wiederherstellungscodes" (remaining count, regenerate), next to the existing device list.
- **Audit**: passkey added / renamed / removed, recovery codes generated / used, setup link created / used, password retired, step-up succeeded / failed, in a new `credential_audit` table (the `auth_audit` event list can't be widened); passkey and recovery logins go to `auth_audit` as `login_succeeded` / `login_failed` with the method as reason.
- **Rate limits** (existing Postgres limiter): failed passkey assertions per client address, recovery-code attempts per username and per address, setup-link checks per address.

## Non-goals

- TOTP (ADR-010 optional fallback) — decide after this has been used for a while.
- The Tauri shell's system-browser sign-in (OAuth code + PKCE), personal access tokens, OAuth / device flow (ADR-010 §6 phases 2–3), service credentials replacing `WEBHOOK_SECRET` (step 5).
- Deriving or storing any key from PRF (cloud phase).
- An admin view of other members' passkeys, or of either audit table.
- Revoking sessions automatically when a passkey is removed (the device list does that explicitly).

## Capabilities

### New Capabilities
- `auth-passkeys`: registering, naming, listing and removing a member's passkeys; signing in with a passkey; which addresses passkeys work on.
- `auth-account-recovery`: recovery codes, setup links (first run, issued by the household admin, host CLI) and what a recovery or setup session may do.
- `auth-password-retirement`: how existing password members move to passkeys, and that password login ends afterwards; invites enrolling a passkey.
- `auth-step-up`: which actions need a recent passkey confirmation and how a client obtains it.

### Modified Capabilities
<!-- none: main specs are not kept in this repo; requirements are written as ADDED -->

## Impact

- **API**:
  - New tables `webauthn_users`, `passkeys`, `webauthn_challenges`, `recovery_codes`, `setup_tokens`, `password_retirements`, `credential_audit` (`schema.sql`, `schema.ts`, pg-mem harness).
  - New dependency `@simplewebauthn/server` (v13, as in the spike).
  - Routes under `/api/auth/passkeys/*`, `/api/auth/recovery*`, `/api/auth/step-up/*`, `/api/setup/:token*`, `/api/household/members/:id/setup-link`; invite redemption becomes begin/finish; `change-password` goes.
  - `@RequireStepUp()` on the sensitive routes; principal gains `authMethod` and `stepUpAt`; restricted sessions (password before enrolment, recovery, setup before enrolment) get only an enrolment scope.
  - CLI `node dist/auth/setup-link-cli.js` (host-only) for first run and last-resort recovery.
- **Web**: `/login` (passkey button, recovery-code form, address hint), `/setup/[token]`, `/invite/[token]` (passkey), enrolment page with recovery codes, `components/settings/Passkeys.vue` + `Wiederherstellung.vue`, a step-up helper in `useApi` (403 `step_up_required` → passkey → retry), `@simplewebauthn/browser`.
- **Config / ops**: `WEBAUTHN_RP_IDS`, `WEBAUTHN_ORIGINS`; `first-run.sh` prints a setup link; `task setup-link`; upgrade runbook: every member enrols a passkey (and should add one per address they use, e.g. the Tailscale hostname).
- **Worker**: none.
- **Docs**: ADR-010 as-built (step 4 complete), CLAUDE.md, configuration, api-reference, runbooks (first-time setup, upgrade, "locked out"), session note.
