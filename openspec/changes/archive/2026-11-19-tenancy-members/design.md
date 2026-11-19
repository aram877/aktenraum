## Context

After `tenancy-foundation` (archived 2026-11-19): `households`, `members`, `spaces`, `space_members`, `document_spaces`, `upload_task_members` exist; every document has a home space mirrored into Paperless (owner = the member's Paperless user `ak-<id>`, view/change for group `space-<id>`); vocabulary is ownerless; RAG retrieval already filters by the caller's spaces; `PolicyService` decides from home-space membership. `members.paperless_user_id` / `spaces.paperless_group_id` are linked by `tenancy/paperless-mirror.ts`.

What still assumes one person: `PaperlessGatewayProvider.require()` hands every service the service-token gateway (13 services, ~43 call sites), uploads are submitted as the service user (so Paperless records the task and the document under it), and members can only be created from `BOOTSTRAP_*` at first start.

Paperless facts this design relies on (spike 2026-11-19 + rehearsal): list/search/detail/preview/download/trash are scoped per user; `/api/tasks/` is scoped to the task's owner; a superuser can PATCH any user's password; `POST /api/token/` returns (creating if needed) that user's token; tags/types/correspondents with `owner = null` resolve for everyone.

## Goals / Non-Goals

**Goals:** a second person can join with a link; each member's requests are isolated by Paperless as well as by the policy; nothing changes for the existing admin's view of their documents; no live-data migration.

**Non-Goals:** see proposal. Additionally: no change to the worker's service token, to RAG (already space-filtered) or to the JWT cookie sessions.

## Decisions

**1. Per-principal gateway, chosen explicitly at every call site.** `PaperlessGatewayProvider` gets `forPrincipal(principal)`: for a member, a `PaperlessGateway` built with that member's token (cached per member, so its 5-minute entity caches work as today); for a service principal, the service gateway. `require()` is renamed `service()` and stays for the worker-facing and tenancy code. Every member-facing service method receives the principal from its controller (`@CurrentPrincipal()`), so the choice is visible in review and a missed site fails typecheck rather than silently using the service token. *Alternative:* request-scoped Nest provider that reads the principal from the request — less plumbing, but invisible at the call site and awkward for SSE and background work; rejected.

**2. Tokens are minted by aktenraum and are disposable.** Minting: superuser PATCHes the member's Paperless user with a fresh random password, `POST /api/token/` as that user, discard the password. Storage: `member_paperless_tokens(member_id PK, ciphertext, iv, auth_tag, key_id, created_at)` with AES-256-GCM under `AKTENRAUM_SECRET_KEY` (32 random bytes, base64; `key_id` = first 8 hex of its SHA-256 so a key change is detected). Use: decrypt on first use per process, keep the plaintext only inside the cached gateway. Failure handling: decryption failure, key mismatch, or a 401/403 from Paperless on a member gateway → mint once, replace the row, retry the call once; a second failure surfaces as 502. Because tokens are re-mintable, losing the key loses nothing. *Alternative:* store the Paperless password instead — longer-lived secret, same protection need; rejected. *Alternative:* no encryption — ADR-010 §8 requires it.

**3. The existing admin needs no migration.** Their token is minted lazily on the first request (or by the tenancy reconcile at startup when the Paperless user is linked). The first deploy is a plain rebuild with the new secret.

**4. Invites store only a hash.** `invites(id, token_hash UNIQUE, household_id, role, created_by_member_id, created_at, expires_at, redeemed_at, redeemed_by_member_id, revoked_at)`; the token is 32 random bytes base64url, stored as SHA-256 hex, compared by hash lookup (no timing oracle on the secret). The api returns the token once; the SPA builds `${location.origin}/invite/<token>` — no server-side knowledge of the public URL (Tailscale / localhost / desktop shell differ). Role is always `member` in this change.

**5. Redemption is one transaction-shaped sequence, retry-safe.** Validate (exists, not redeemed/revoked/expired) → create `users` row (bcrypt, same rules as change-password) → `reconcileTenancy` creates member + personal space → mark invite redeemed (conditional update `WHERE redeemed_at IS NULL`, so two concurrent redemptions can't both win; the loser's user row is deleted) → provision Paperless user + group + token (`provisionSpaceGroup`, mint) → set the session cookie. If Paperless provisioning fails after the DB part, the member exists and logs in; provisioning is retried lazily on their first request (the mirror is idempotent), so a Paperless blip never strands a redeemed invite.

**6. Public routes, same CSRF.** `GET /api/invites/:token` and `POST /api/invites/:token/redeem` are added to the route inventory's public allowlist; `POST` from the SPA is same-origin so the `Sec-Fetch-Site` CSRF check passes as for login. Invalid/expired/revoked/used all answer `404 {detail: "Einladung ungültig oder abgelaufen"}`. Rate limit: an `InviteThrottle` like `LoginThrottle` (in-memory, 10 failures / 15 min per IP, 429 + `Retry-After`); persisted limits come with ADR-010 step 4.

**7. Admin endpoints under `household/`.** `GET/POST /api/household/invites`, `DELETE /api/household/invites/:id`, `GET /api/household/members`, all `@RequireScope("household:admin")`.

**8. Uploads with the member token; activity split by role.** `UploadService` posts with `forPrincipal`; `upload_task_members` keeps recording the member (home-space assignment is unchanged). Import activity: household admin → service gateway (sees mail/folder tasks, which belong to the service user / mail-rule owner); member → their gateway (Paperless returns only their tasks). Source classification is unchanged.

**9. Live counts per connection.** `EventsService.computeCounts(principal)`; the SSE controller polls with the connection's principal. Counts and the 30 s fallback polls follow the same gateway as the pages they summarise.

**10. SPA.** `/settings` gets a "Mitglieder" section (admin only, from `/auth/me` which gains `household_role`): member list, "Einladungslink erstellen" (shows the link once with a copy button and the expiry), pending invites with "Widerrufen". Household settings sections (models, auto-approve) render read-only for non-admins. New `/invite/[token]` page (bare layout, guest middleware): checks the token, then username + password + confirmation; success navigates to `/`.

## Risks / Trade-offs

- **Missed call site → a member sees household data through the service token.** Mitigation: `require()` renamed so every remaining use is deliberate and greppable; an api test matrix with two members asserts every member-facing route answers only the caller's documents against a fake Paperless that enforces per-token visibility (the `FakeGateway.visibleTo` model).
- **More Paperless tokens = more credentials at rest.** Encrypted, server-only, re-mintable, revoked implicitly when the password is rotated at the next mint.
- **The admin no longer sees documents that have no home space yet** (owned by the service user for the seconds between consumption and the worker's assignment). Acceptable; the in-flight pill still counts them for the admin via the service-scoped activity.
- **Paperless superuser password PATCH semantics** could change in a future Paperless version; the rehearsal on the e2e stack covers it and `scripts/spikes/` is re-run on upgrades.
- **Rollback:** the change adds tables and a secret; reverting the code leaves them unused. Members created in the meantime keep their Paperless users; nothing to undo in document data.

## Migration Plan

1. `bootstrap-secrets.sh` fills `AKTENRAUM_SECRET_KEY`; `task build` recreates the api (sessions stay valid — `JWT_SECRET` unchanged).
2. On first request the admin's token is minted; their library is unchanged (they own every document).
3. Invite a test member, redeem in a private window, verify isolation in both directions, then invite the real second member.

## Open Questions

None blocking. Removing a member and space transfer are deferred (non-goal); persisted rate limits wait for ADR-010 step 4.
