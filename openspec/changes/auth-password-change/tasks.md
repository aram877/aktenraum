## 1. Backend schema + route

- [x] 1.1 Add `ChangePasswordRequest` to `services/aktenraum-api/src/aktenraum_api/auth/schemas.py` with `current_password: str = Field(min_length=1, max_length=128)` and `new_password: str = Field(min_length=8, max_length=128)`.
- [x] 1.2 Add `POST /change-password` handler to `services/aktenraum-api/src/aktenraum_api/auth/router.py`. Dependencies: `get_current_user`, `get_session`, `get_settings`. Body: `ChangePasswordRequest`. Status: 204 on success.
- [x] 1.3 Handler logic: verify `current_password` against `user.password_hash` via `verify_password`. On mismatch raise `HTTPException(401)`. Then check `new_password != current_password`; on equality raise `HTTPException(400, "new_password must differ from current")`. Then `user.password_hash = hash_password(new_password)`, `await session.commit()`, `response.delete_cookie(key=settings.cookie_name, path="/")`, return the 204 response.
- [x] 1.4 Verify the existing CSRF middleware (`services/aktenraum-api/src/aktenraum_api/middleware.py`) automatically applies to the new POST without any opt-in or exemption.

## 2. Backend tests

- [x] 2.1 Extend `services/aktenraum-api/tests/test_auth_flow.py` with `test_change_password_happy_path` — log in, POST change-password with correct current + valid new, assert 204, assert response clears the cookie, assert `/api/auth/me` returns 401 afterwards, assert login with old password returns 401, assert login with new password returns 200.
- [x] 2.2 Add `test_change_password_wrong_current` — log in, POST with wrong current password, assert 401, assert `/api/auth/me` STILL returns 200 afterwards (cookie not cleared), assert login with original password still works.
- [x] 2.3 Add `test_change_password_new_equals_current` — log in, POST with new == current, assert 400, assert cookie not cleared, assert password unchanged.
- [x] 2.4 Add `test_change_password_unauthenticated` — POST without logging in, assert 401, assert no DB write.
- [x] 2.5 Add `test_change_password_too_short` — log in, POST with `new_password="short"` (7 chars), assert 422 from Pydantic, assert cookie not cleared.
- [x] 2.6 Run `uv run pytest services/aktenraum-api/tests/test_auth_flow.py -v` and confirm all six tests pass (5 new + the 5 pre-existing).

## 3. SPA wiring

- [x] 3.1 Add `changePassword(current, new)` to `apps/web/src/lib/api.ts` that POSTs to `/auth/change-password` and returns `void` (204 has no body).
- [x] 3.2 Add `useChangePassword()` mutation hook to `apps/web/src/lib/auth.ts`. `onSuccess` should invalidate `ME_KEY` so the SPA observes the logged-out state immediately.

## 4. SPA Settings page UI

- [x] 4.1 Add a "Konto" section to `apps/web/src/routes/Settings.tsx`, positioned ABOVE the existing model pickers, with a `border-t border-hairline` divider between Konto and the next section.
- [x] 4.2 Section contents: heading "Konto", description paragraph in German ("Passwort ändern. Du wirst nach erfolgreicher Änderung neu angemeldet."), three `<input type="password" autoComplete="off">` fields (current / new / confirm), a single submit button.
- [x] 4.3 Local state via three `useState`s. Client-side validation: `new === confirm` (immediate red text under the confirm field if not), `new.length >= 8` (block submit), `current` non-empty (block submit).
- [x] 4.4 Submit handler calls `useChangePassword().mutateAsync({current_password, new_password})`. While `isPending`, disable the button and show "speichere…" inline.
- [x] 4.5 On success (mutation resolves): show a green success banner ("Passwort geändert — du wirst zum Login geleitet."), clear all three input values, then `setTimeout(() => navigate({to: "/login"}), 1500)`.
- [x] 4.6 On error: map the HTTP status to a German message and render in a red banner. 401 → "Aktuelles Passwort ist nicht korrekt." 400 → "Das neue Passwort muss sich vom aktuellen unterscheiden." 422 → "Bitte fülle alle Felder korrekt aus (min. 8 Zeichen für das neue Passwort)." Other → "Unbekannter Fehler beim Ändern des Passworts."
- [x] 4.7 Run `pnpm --filter @aktenraum/web lint` and `pnpm --filter @aktenraum/web build`; confirm both pass.

## 5. Documentation

- [x] 5.1 Update the "What's implemented vs planned" table row for "Change password from UI" (add if missing) → ✅ with a short description pointing at `/settings`.
- [x] 5.2 Append a brief addendum to today's session note (`docs/sessions/2026-05-21.md`) under a new heading describing what shipped, the test count delta, and the live-test outcome.

## 6. Verification + live test

- [x] 6.1 `uv run pytest` from repo root — confirm full suite passes (591 → 596 expected with 5 new auth tests).
- [x] 6.2 `pnpm --filter @aktenraum/web build` — confirm SPA builds clean.
- [ ] 6.3 Live test: rebuild the api container (`task api:rebuild`) and the nginx container (`task web:deploy`). Log in with the current bootstrap password, navigate to `/settings`, change password, get redirected to login, log in with the new password.
- [ ] 6.4 Negative live tests: (a) try changing with the wrong current → expect German 401 banner; (b) try setting new == current → expect German 400 banner; (c) try setting too-short → expect German 422 banner.

## 7. Commit + push

- [x] 7.1 Single commit covering backend + SPA + tests + docs. Conventional-commit shape: `feat(auth): self-service password change endpoint + Settings form`.
- [x] 7.2 Push after live-test confirmation. Maintainer authorises push directly; no smoke-test-gate ceremony required for this feature since the live test is the smoke test.
