# Locked out — getting back in without a passkey

aktenraum signs in with passkeys (auth-passkeys, ADR-010). If a member's
passkey is gone (lost phone, new computer, wiped browser profile), use the
first of these that applies. Every way back ends with a **new passkey**.

## 1. A recovery code (the member themselves)

Every member got 10 recovery codes with their first passkey.

1. Open the login page → **Wiederherstellungscode verwenden**.
2. Username + one code (`XXXX-XXXX-XXXX-XXXX`; case, spaces and dashes don't
   matter). The code is used up.
3. The app asks for a new passkey right away (nothing else is reachable
   before that) — create it.
4. Afterwards: `/settings → Konto → Wiederherstellungscodes` shows how many are
   left; **Neue Codes erstellen** makes a fresh set (the old ones stop working).
   In `/settings → Konto → Geräte` sign out the lost device; in **Passkeys**
   remove the lost passkey.

10 wrong codes for a username, or from one address, within 15 minutes block
further attempts for 15 minutes (`429`).

## 2. A setup link from the household admin

The member has no passkey and no code left, but the household admin can sign in.

1. Admin: `/settings → Mitglieder` → **Einrichtungslink erstellen** next to the
   member (asks for the admin's passkey). The link is shown once and works
   once, for 30 minutes.
2. Hand it over in person / a trusted channel. The member opens it, creates a
   passkey and gets a **new** set of recovery codes (old codes stop working).
3. The member then signs out lost devices in `/settings → Konto → Geräte`.

## 3. The host command (nobody can sign in)

For a single-member household, or when the admin is the one locked out. Needs
a shell on the machine that runs aktenraum.

```bash
task setup-link USER=<username>
# or: bash scripts/setup-link.sh <username>
# or: docker compose --project-directory docker exec aktenraum-api node dist/auth/setup-link-cli.js <username>
```

It prints `http://localhost:8080/setup/<token>` (the first `WEBAUTHN_ORIGINS`
entry). Open it **on that address** within 30 minutes. Exit code 4 = no active
member with that name (`docker compose … exec postgres psql -U paperless -d
aktenraum -c "SELECT username FROM users"` lists them).

## Passkey dialog doesn't appear / "nicht eingerichtet"

- The page must be opened on an address in `WEBAUTHN_ORIGINS` — never an IP
  address (`http://192.168.…` can't use passkeys). The login page names the
  working addresses.
- A passkey works only on the address it was created on. To use another one
  (e.g. the Tailscale name), add it to `WEBAUTHN_ORIGINS` and `WEBAUTHN_RP_IDS`
  in `docker/.env`, run `docker compose --project-directory docker up -d
  aktenraum-api`, sign in there with a recovery code or setup link once, and add
  a passkey.

## Audit

Every recovery-code use, setup link (who issued it, or "host") and passkey
change is in `credential_audit`; recovery sign-ins in `auth_audit`
(`reason = 'recovery'`). Neither table holds codes or link tokens.
