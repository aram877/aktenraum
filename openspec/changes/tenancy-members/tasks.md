## 1. Secret + token storage

- [x] 1.1 `AKTENRAUM_SECRET_KEY` in `config/settings.ts` (fail-closed at start, like `JWT_SECRET`), `docker/.env.example`, `scripts/bootstrap-secrets.sh` (`fill_if_empty`, base64 32 bytes); test harness env
- [x] 1.2 `member_paperless_tokens` + `invites` in `schema.ts`, `schema.sql`, harness; verify on a throwaway `postgres:15` (apply twice + constraints)
- [x] 1.3 `tenancy/token-vault.ts`: AES-256-GCM encrypt/decrypt with `key_id`; tests (round trip, wrong key, tampered tag)
- [x] 1.4 Gateway: mint a member token (password PATCH + `/api/token/` as the user); fake Paperless supports per-user tokens and enforces visibility per token

## 2. Per-principal gateway

- [x] 2.1 `PaperlessGatewayProvider.forPrincipal(principal)` with per-member cache; rename `require()` → `service()`; lazy provisioning + mint; on 401/403 or undecryptable token: re-mint once, retry once, else 502
- [x] 2.2 Thread the principal through every member-facing service: library, documents (detail/preview/download/status/task/in-flight/duplicates/reprocess/delete/star), inbox, trash, upload, events (SSE + counts), ingest (admin → service, member → own), ai (structured search, enrich, answer)
- [x] 2.3 Remaining `service()` uses reviewed and listed in the session note (worker routes, tenancy, home space, migration)
- [x] 2.4 Tests: two-member isolation matrix over every member-facing route (lists, counts, by-id 404s, writes), re-mint on 401, admin view unchanged

## 3. Invites + members

- [ ] 3.1 `household/` module: create / list / revoke invites, list members (`household:admin`)
- [ ] 3.2 Public `GET /api/invites/:token` + `POST /api/invites/:token/redeem` (uniform 404, `InviteThrottle`, conditional redeem, provisioning, session cookie); route-inventory allowlist
- [ ] 3.3 `/auth/me` returns `household_role`
- [ ] 3.4 Tests: create/list/revoke/expiry/single use/concurrent redeem/username taken/throttle/non-admin 403/provisioning failure still logs in

## 4. Web

- [ ] 4.1 `/settings` "Mitglieder" (admin): members, create link (shown once, copy, expiry), pending invites + revoke; household sections read-only for members
- [ ] 4.2 `/invite/[token]` page (bare layout, guest): validity check, username + password + confirm, errors (taken, invalid, throttled), redirect to `/`
- [ ] 4.3 Tests (`mountSuspended`): admin vs member settings, invite creation flow, redeem page states

## 5. Docs + verify

- [ ] 5.1 ADR-010 amendment (interim password invites), CLAUDE.md (gateway rule, secret, invites, gotchas, counts), upgrade runbook (new secret → `task build`), configuration.md, api-reference.md, session note
- [ ] 5.2 `pnpm -r lint`, `pnpm -r build`, api + web typecheck, `pnpm -r test`
- [ ] 5.3 e2e stack: `bash scripts/e2e-worker.sh` still 20/20; invite + redeem a second member against the real Paperless and check isolation both ways through the api

## 6. Live (maintainer present, explicit OK per step)

- [ ] 6.1 `bootstrap-secrets.sh` (adds the key), backup snapshot, `task build`
- [ ] 6.2 Admin's library unchanged (count = 257 + new); invite a test member, redeem in a private window, check isolation both ways in the browser
- [ ] 6.3 Remove the test member's access by hand if wanted (no removal flow yet — documented)
