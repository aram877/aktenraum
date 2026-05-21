## Context

The auth surface is small (3 endpoints, ~50 lines of router code) and well-tested (`test_auth_flow.py` covers login / wrong-password / unknown-user / `/me` / logout / cookie clearing). Bcrypt hashing is centralised in `auth/passwords.py` (`hash_password` + `verify_password`). The User model has only three columns (id, username, password_hash, created_at) — no `updated_at`, no `password_changed_at`. The `db.session.get_session` dependency yields an `AsyncSession`; commits happen explicitly in handlers (the session factory doesn't auto-commit).

What this change must NOT break:
- The bootstrap-on-empty-users flow. `users` is single-row in practice but the schema allows N rows; bootstrap stays as-is.
- Cookie semantics. The auth cookie is httpOnly, SameSite=Lax, Secure when `COOKIE_SECURE=true`. Whatever this change does on success must respect the same flags so future-Tauri-WebView and present-Tailscale-browser-on-mobile both keep working.
- The CSRF middleware. State-changing requests require `Sec-Fetch-Site: same-origin` (or no header for non-browser clients) per ADR-003. The new endpoint is a POST — it's automatically inside the CSRF perimeter, no opt-in needed.

The user model has no `updated_at` column. We could add one for password-changed timestamps, but the JWT cookie's `exp` already gates session lifetime, and "when did I last change my password" is a feature nobody asked for. Skip.

## Goals / Non-Goals

**Goals:**
- The maintainer can rotate their password from the `/settings` page in under 30 seconds without ever touching the env file, psql, or any container shell.
- The verify-current-password gate makes a stolen-cookie scenario insufficient on its own to lock the maintainer out of their own account.
- Successful change clears the cookie so the maintainer (a) explicitly re-authenticates with the new password (sanity-check that they typed it correctly), and (b) any other live session — second browser tab, phone left logged in — is forced to re-login.
- Tests cover happy path + the three rejectable cases.

**Non-Goals:**
- Password strength meter or complexity rules. 8 chars is the floor; the maintainer is responsible for choosing a strong one. The Tailscale perimeter and bcrypt cost factor mean weak passwords aren't the highest risk in the threat model.
- Telling the user WHICH validation failed in the response body beyond what the HTTP status implies. 401 → wrong current password, 400 → new == current, 422 → length / type. The SPA presents German prose for each.
- An audit log entry. Single-user product; the maintainer is the only actor.
- A "password last changed" field on the user model. Adds DB churn for no user-visible value.
- Self-service password reset (forgot-password). No SMTP. The terminal-based bcrypt-UPDATE path remains the recovery story.
- Logging the new password's hash, even in DEBUG. Don't tempt the future.

## Decisions

### 1. Endpoint shape: `POST /auth/change-password` returning 204 + cleared cookie

The endpoint is a sibling of `/auth/login` and `/auth/logout`, lives in the same router. Reasons:
- Same auth dependency (`get_current_user`) and same session dependency — no duplication.
- Same cookie management (`response.delete_cookie(...)`) — reuses the logout pattern.
- Same Settings/JWT dependency — reuses `get_settings`.

204 No Content matches the logout endpoint's contract for "we did the thing, nothing to return". The cleared cookie travels in the `Set-Cookie` response header alongside the 204; browsers honour that combination.

Alternative considered: return 200 with `{ok: true}` or `{message: "..."}`. Rejected — the SPA already knows the action succeeded if the status is 2xx; an explicit body adds shape for no caller benefit.

### 2. Verify current password — defence against stolen-cookie scenarios

If `change-password` only required a valid cookie, then anyone who stole the cookie (via malware on the host machine, an extension exfiltrating cookies, a misconfigured Tailscale ACL letting another tailnet member's device reach the host) could lock the legitimate owner out of their own account by setting a new password.

Requiring `current_password` defangs that: the attacker would need BOTH the cookie AND the current password — at which point they already have the credentials to log in directly and don't need to change them.

Cost: one extra typed field on the form. Worth it.

Alternative considered: omit the current-password check. Rejected per the threat model above. The change-password verb is asymmetric — it grants an attacker persistence, not just access. Defaults should be defensive.

### 3. Reject `new_password == current_password`

If a user types the same password into both fields, they've achieved nothing — but the API would happily run a fresh `hash_password` cycle, commit the same logical state, and return 204. The user would think they'd rotated. They didn't.

Catch this server-side (and not just in the SPA), because the SPA can be bypassed and the invariant "if you rotate, the password actually changed" should be enforceable on its own. Returns 400 Bad Request with detail `"new_password must differ from current"`.

Alternative considered: silently no-op on same-as-current. Rejected — a no-op pretending to be a write is a UX trap.

### 4. Clear the cookie on success — force re-login

Two reasons:
- **Sanity-check**: the maintainer re-types the new password immediately. If they mis-typed it in the change form (and the SPA's confirm field passed because they mis-typed it identically twice), re-login surfaces the bug instantly. The alternative is to discover the typo days later when their phone session expires.
- **Session invalidation**: a password change should kick all other live sessions for the same user. Today there's no server-side session store — JWTs are signed and stateless — so the only way to invalidate ALL existing JWTs would be to rotate the `JWT_SECRET`. That's a sledgehammer (logs out the user from every tab they currently have open). Clearing the cookie achieves the practical outcome on the CURRENT device. For OTHER devices, their JWTs are still technically valid until their `exp` (default 8h). This is a known limitation we accept in v1.

Alternative considered: don't clear the cookie on success — the user stays logged in with the same JWT (which contains user id, not password). Rejected because (a) the re-login sanity-check is valuable and (b) the explicit "log out + log in again" pattern is the standard UX expectation post-password-change across most apps.

Alternative considered: rotate `JWT_SECRET` on every password change so existing JWTs become invalid everywhere. Rejected — `JWT_SECRET` is a process-wide secret stored in env; rotating it requires restarting the API (which boots out the user mid-flow) and would invalidate every other user's session in a multi-user future. Wrong granularity.

To do proper per-user session revocation later we'd need a server-side session table or a `password_version` column added to the JWT claim; both are out of scope for v1. Document as a follow-up.

### 5. Pydantic field bounds: 1..128 for current, 8..128 for new

Current password's min is 1 because we don't know what the previous password is — could be a 4-char old test password from before this feature existed. We can't impose a floor retroactively.

New password's min is 8. Not based on entropy science (which would say 12-14 for offline attacks); based on "high enough to be self-evidently not 'admin' / 'test' / 'pass'", low enough not to make the maintainer fight the form. Bcrypt + Tailscale perimeter handle the rest.

Both have max 128 because the User.password_hash column is String(255), bcrypt output is fixed at ~60 chars, and 128 input chars stretches comfortably below that. Also defends against the "send a 100MB password to DoS the bcrypt computation" attack class — bcrypt's cost is per-hash, but a 100MB string would still cost something to transmit and process.

### 6. SPA form: three fields, client-side confirm-match, no extra UX layer

The form is intentionally boring:
- Current password
- New password
- Confirm new password

Client-side: confirm must equal new (immediate red text under the confirm field if not, submit disabled). Min-length 8 enforced via HTML5 + manual check. No password-strength meter (creates an arms race with users typing `Password1!` to satisfy the meter).

On submit: hit the API, show pending state on the button. On 2xx success: clear all three fields, show a green banner "Passwort geändert — du wirst zum Login geleitet." Trigger a 1.5s `setTimeout` that calls `navigate({to: "/login"})`. The grace window is so the user reads the message; the auto-redirect prevents the "now what" cliff.

On 4xx error: show a red banner with German prose mapped from status:
- 401 → "Aktuelles Passwort ist nicht korrekt."
- 400 → "Das neue Passwort muss sich vom aktuellen unterscheiden."
- 422 → "Bitte fülle alle Felder korrekt aus (min. 8 Zeichen für das neue Passwort)."
- Anything else → fall back to "Unbekannter Fehler beim Ändern des Passworts."

Form state lives in three `useState`s on the Settings page. Submission via `useChangePassword().mutateAsync`. No new routes, no separate page.

### 7. Where in Settings does it go?

Above the existing model pickers. The Account section is "who am I" — appears before "what models do I use". Visual hierarchy: section header "Konto", paragraph description ("Passwort ändern. Du wirst nach erfolgreicher Änderung neu angemeldet."), form. Then a `border-t border-hairline` divider, then the existing model pickers.

Alternative considered: separate `/settings/account` route. Rejected — overkill for one form in a product with one user. Keep one Settings page until there's a reason to split it.

## Risks / Trade-offs

- **[Stolen-cookie attacker still has the cookie, can still call /me etc.]** → Mitigation: out of scope for this change. The threat model that change-password must defend against is "lock the legitimate user out of their own account". Read-access via stolen cookie is a separate problem (mitigation is short JWT exp + cookie security + Tailscale perimeter). Documented as a known limitation; revisit when server-side session storage exists.
- **[Other live sessions on the same user keep working with their old JWTs until exp]** → Mitigation: documented in this design as a v1 limitation. Maintainer who wants instant kill-all can rotate `JWT_SECRET` and recreate the api container (existing pattern). Most users won't care because (a) JWT exp default is 8h and (b) they probably only have one or two sessions anyway.
- **[User forgets the new password seconds after setting it]** → Mitigation: the existing bcrypt-UPDATE-via-psql recovery path documented in CLAUDE.md still works. Add a one-line pointer in the Konto section description? Probably not — too much for the happy path. The recovery story is in the docs.
- **[A bug in the new-password validator commits an empty hash]** → Mitigation: Pydantic min_length=8 enforced before the handler runs. The handler never sees a too-short value to mishandle.
- **[Race: two simultaneous change-password requests interleave]** → Mitigation: SQLAlchemy session.commit is serialised per session; the second request would either see the just-committed state (current_password no longer matches → 401) or commit second (last-write-wins on the same row). Either way is acceptable; the worst case is one of the two clients gets a confusing 401, which is recoverable by re-trying with the fresh password. Not worth row-locking for a single-user product.
- **[The success banner + 1.5s redirect feels slow on mobile]** → Mitigation: the 1.5s is generous enough that distracted users see the confirmation; if it feels too slow in practice we can dial down to 800ms. Cheap iteration target.

## Migration Plan

1. **Backend**: add the schema + route + tests. Run `uv run pytest`. Confirm 591 → 595+ tests passing.
2. **SPA**: add the api helper, the mutation hook, the Settings form section. Run `pnpm --filter @aktenraum/web lint` and `pnpm --filter @aktenraum/web build`.
3. **Live test** on the maintainer's setup: log in with bootstrap password, navigate to `/settings`, change password, get redirected to login, re-login with new password.
4. **CLAUDE.md update**: one row in the implemented-vs-planned table flipping "Change password from UI" to ✅. Note in known-gotchas if anything surfaces during the live test.
5. **Commit**: single commit for the whole feature (backend + SPA + tests + docs). Per project discipline: tests green before commit, no commit during active bug-fix.

Rollback is a plain revert: the new endpoint is additive, the SPA section is additive. Reverting removes both with no DB state to clean up (existing `password_hash` rows are unchanged; the column has been writable since day one).

## Open Questions

- **Do we want a per-user `password_version` claim in the JWT to enable proper session invalidation later?** Defer. v1 ships the cookie-clear pattern; if the maintainer hits the "phone still logged in 6 hours after I changed the password" complaint we can add the claim then. The migration cost is low (~10 lines + a new column on `users`).
- **Should the SPA also offer a "Log out everywhere" button alongside change-password?** Currently moot (JWTs are stateless, can't be invalidated without rotating the secret). Becomes a real feature once server-side sessions exist.
- **Bcrypt cost factor (currently passlib default = 12 for bcrypt)?** Default is fine for now. Worth re-evaluating only if first-login latency becomes user-visible — at cost 12 a single verify takes ~150ms on modern hardware, well below "noticeable".
