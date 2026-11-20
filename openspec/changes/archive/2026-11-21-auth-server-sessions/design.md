# Design

## Context

- Sessions today: `AuthService.issueSession` signs an HS256 JWT (`auth/jwt.ts`, `jsonwebtoken`) with `sub` = `users.id` and `pwf` = a hash of the password hash; `AuthGuard` verifies it, then resolves the member through `TenancyService.resolveMember`. Invite redemption also calls `issueSession`. Logout and change-password only clear the cookie.
- The member principal already has `sessionId: string | null` and `authTime: Date | null` (always null today), placed there by ADR-010 step 2 for this change.
- `LoginThrottle` is an in-memory map, used per username by `/auth/login` and per `request.ip` by the invite routes.
- `main.ts` doesn't set `trust proxy`. nginx forwards `X-Forwarded-For` (`$proxy_add_x_forwarded_for`) and `X-Real-IP`, so every request's `request.ip` is the nginx container's address today.
- `applySchema` only runs `CREATE TABLE IF NOT EXISTS`: whatever `auth-passkeys` will need on `sessions` must be created now.
- pg-mem's `now()` is offset by the local UTC offset; every expiry comparison happens inside SQL (existing gotcha).
- The live-counts stream (`EventsController`) re-checks member removal each 3 s tick since `tenancy-member-removal`.

## Goals / Non-Goals

**Goals:**
- One indexed lookup per authenticated request, no extra round trips; at most one write per session per minute.
- No secret or token value ever stored or logged; the cookie value is useless to anyone reading the database or the logs.
- `auth-passkeys` can build on the tables without a schema migration.

**Non-Goals:**
- Caching sessions in memory (a revoke must be effective on the next request).
- Signed or encrypted cookies, or any JWT variant: the token is a lookup key only.

## Decisions

### 1. Tables

```
sessions(
  id                  bigserial PK,
  token_hash          varchar(64) UNIQUE NOT NULL,   -- sha256 hex of the cookie token
  member_id           → members.id NOT NULL,
  household_id        → households.id NOT NULL,
  client_id           varchar(32) NOT NULL DEFAULT 'spa',
  auth_method         varchar(16) NOT NULL CHECK IN ('password','invite','passkey','recovery','setup'),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  step_up_at          timestamptz NULL,              -- auth-passkeys
  user_agent          varchar(512) NULL,
  ip                  varchar(64) NULL,
  revoked_at          timestamptz NULL,
  revoked_reason      varchar(32) NULL CHECK IN ('logout','user','other_device','password_change','member_removed')
)
INDEX sessions_member_id_idx (member_id)

auth_rate_limit_events(id bigserial PK, key varchar(160) NOT NULL, at timestamptz NOT NULL DEFAULT now())
INDEX (key, at)

auth_audit(
  id bigserial PK, at timestamptz DEFAULT now(),
  event varchar(32) CHECK IN ('login_succeeded','login_failed','login_throttled','logout',
                              'session_revoked','password_changed','invite_redeemed'),
  member_id int NULL, actor_member_id int NULL, session_id bigint NULL,
  username varchar(64) NULL,          -- the attempted name for failed/throttled logins
  reason varchar(32) NULL, ip varchar(64) NULL, user_agent varchar(512) NULL
)
INDEX (at)
```

`auth_audit` has no foreign keys (like `share_audit`): it must outlive anything it mentions. The `auth_method` and `revoked_reason` value lists already include what `auth-passkeys` adds (`passkey`, `recovery`, `setup`), because a `CHECK` can't be widened by `applySchema` either.
*Alternative*: one generic `audit_log` table shared with `share_audit`. Rejected: `share_audit` is live and has its own readers; merging is a separate refactor.

### 2. Token and cookie

- Token: 32 bytes from `randomBytes`, base64url (43 chars). Stored: `sha256(token)` hex. Lookup: `WHERE token_hash = $1 AND revoked_at IS NULL AND idle_expires_at > now() AND absolute_expires_at > now()`. No constant-time compare needed: the comparison is an index lookup on a hash of a 256-bit secret.
- Cookie name: `__Host-aktenraum_session` when `COOKIE_SECURE=true` (requires `Secure`, `Path=/`, no `Domain` — all already true), else `aktenraum_session`. `Max-Age` = 30 days; the server decides expiry, the cookie only has to outlive the session. Login and logout also clear the other name, so an old JWT cookie never lingers next to the new one.
- `issueSession(response, member, method, request)` writes the row and the cookie; login and invite redemption call it.
*Alternative*: keep the JWT and add a `jti` deny-list. Rejected: two mechanisms, still no device list, and ADR-010 §3 already decided opaque tokens.

### 3. Resolution, sliding expiry, principal

`AuthGuard` → `SessionService.resolve(token)` returns `{sessionId, memberId, userId, createdAt}` or null (one query joining `members` for `user_id`), then `TenancyService.resolveMember(userId)` as today (keeps the removed-member filter as a second line). The principal gets `sessionId = String(id)` and `authTime = created_at`.
Touch: when `last_seen_at < now() - interval '1 minute'`, `UPDATE … SET last_seen_at = now(), idle_expires_at = least(now() + idle, absolute_expires_at)`, fire-and-forget (a failed touch never fails the request). `ip` and `user_agent` are those of login and stay fixed (the device list shows where the session started).

### 4. Revocation paths

All set `revoked_at = now()` and `revoked_reason`, plus an audit entry:
- `POST /auth/logout` → current session, `logout` (no guard: an unknown or expired cookie is a no-op and still clears the cookie).
- `POST /auth/change-password` → every session of the member, `password_change`; cookie cleared (unchanged UX: re-login on this device).
- `DELETE /auth/sessions/:id` → own session only (`member_id` = caller, else 404), `user` for the current one (cookie cleared), `other_device` otherwise.
- `POST /auth/sessions/revoke-others` → every active session of the caller except the current one, `other_device`; answers `{revoked: n}`.
- `MemberRemovalService` lockout step → every session of the removed member, `member_removed` (in the same step as the `member_removals` insert).

### 5. Device list

`GET /auth/sessions` (scope: any authenticated member, `@RequireScope()`): active sessions of the caller, newest use first: `{id, created_at, last_seen_at, auth_method, ip, user_agent, current}`. The SPA turns the user agent into "Chrome · Windows" with a small pure helper (no UA library — a few regexes for the browsers and systems that matter; unknown → "Unbekanntes Gerät").

### 6. Rate limiter in Postgres

`AuthRateLimiter` replaces `LoginThrottle` with the same interface (`retryAfterSeconds(keys)`, `recordFailure(keys)`, `reset(key)`), now async and multi-key:
- login: keys `login:user:<lowercased username>` and `login:ip:<ip>`; throttled when **either** has ≥ 10 events in the last 15 minutes; a failure records both; success resets only the username key (an address that sprayed stays limited).
- invites: `invite:ip:<ip>`.
- `Retry-After` = seconds until the oldest counted event leaves the window, computed in SQL (`extract(epoch from min(at) + interval '15 minutes' - now())`).
Events, not a counter row: inserts never conflict, the window is exact, and pruning is a plain delete.
*Alternative*: keep memory, add a per-IP map. Rejected: resets on restart (spec), and the api restarts on every deploy.

### 7. Trusting nginx

`app.set("trust proxy", 1)`: Express takes the right-most `X-Forwarded-For` entry, which nginx appends from the real socket, so a client can't spoof its address by sending the header itself. Direct callers inside the Docker network (the worker) have no header and get their container address. The dev Nuxt server proxies to nginx, so the same holds in `task web:dev`.
*Alternative*: read `X-Real-IP`. Rejected: non-standard for Express, and `request.ip` is what every existing call site already uses.

### 8. Audit log

`AuthAuditService.record(event, fields)` inserts one row; best effort (a failure logs `auth_audit_failed` and never fails the request), like `share_audit`. User agent truncated to 512 chars. Login failures record the attempted username (truncated to 64), never the password; nothing ever records a token or its hash.

### 9. Streams

`EventsController` replaces the per-tick `isMemberRemoved` check with `SessionService.isActive(sessionId)` (the same SQL predicate as `resolve`, by primary key, no touch). Member removal revokes sessions, so one check covers revoke, expiry, password change and removal; it writes `event: session_ended` (data: `revoked` / `expired`) and ends. The SPA handling from `tenancy-member-removal` stays as it is.

### 10. Sweep

`AuthSweepService`: once at startup and hourly (unref'd timer): delete sessions revoked or expired more than 30 days ago (the device list only shows active ones; the audit keeps the history), rate-limit events older than 1 day, audit rows older than 180 days.

### 11. Retiring the JWT

`auth/jwt.ts`, `passwordFingerprint`, the `jsonwebtoken` dependency and `JWT_SECRET` / `JWT_EXPIRES_SECONDS` in `config/settings.ts` go. `.env.example`, `docs/configuration.md` and `bootstrap-secrets.sh` stop mentioning them; existing `docker/.env` files keep the lines (harmless, and they make a code rollback start without editing `.env`).

## Risks / Trade-offs

- [One DB lookup per request instead of a signature check] → indexed unique lookup on a 64-char hash; the api already queries `members` per request. Measure on the e2e stack; acceptable well below 1 ms on Postgres 15.
- [A stolen cookie works until revoked or expired (30 days max)] → same class as today's JWT but now revocable from the device list; `auth-passkeys` adds step-up for sensitive actions.
- [Per-address limit locks out a household behind one NAT when someone sprays] → 10 failures / 15 min, then automatic; members on the same address can still use existing sessions. Logged as `login_throttled`.
- [Username lockout as a nuisance attack (existing)] → unchanged from today; passkeys in `auth-passkeys` remove passwords from normal login.
- [Everyone logs in again once] → documented in the upgrade runbook and the session note; the live household is one or two people.
- [`trust proxy` misconfigured if someone exposes the api port directly] → the compose file publishes only nginx; documented next to the setting.

## Migration Plan

- Deploy: `applySchema` creates the three tables; all JWT cookies answer 401 → one login per device. No data migration.
- Rehearse on the e2e stack: login → device list on two agents → revoke other → 401; logout replay → 401; password change → both 401; open stream + revoke → `session_ended`; 11 failed logins → 429, api restart → still 429; two client addresses (direct + via a second forwarded hop) throttled independently.
- Rollback: revert the code. `JWT_SECRET` is still in `docker/.env`, so the old api starts; everyone logs in once more. The new tables stay unused.

## Open Questions

- Whether a household admin should later see (and revoke) other members' sessions and the audit log — a UI decision for after `auth-passkeys`; the data is already recorded.
