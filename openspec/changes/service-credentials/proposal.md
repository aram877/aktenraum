# Proposal

## Why

All internal calls share one value, `WEBHOOK_SECRET`. Paperless's post-consume hook, the api calling the worker, and the worker calling the api all send the same `X-Aktenraum-Secret`. Two problems follow (ADR-010 audit findings D and F). First, the hook can do everything the worker can, including reading the api's settings, assigning home spaces and writing type fields. Second, no log line can tell who made a call. Members, sessions and passkeys are live now (ADR-010 steps 1–4), so the internal side is the last place where one value grants everything. This change is ADR-010 step 5: **one credential per caller, each allowed exactly the calls that caller makes**.

## What Changes

- **Three service credentials** replace `WEBHOOK_SECRET`: `SVC_TOKEN_PAPERLESS_HOOK`, `SVC_TOKEN_WORKER`, `SVC_TOKEN_API`. `scripts/bootstrap-secrets.sh` generates them, and on existing installs it fills them in at the next run. Each one is sent as `Authorization: Bearer <token>`.
- **Each credential gets a fixed allowance**:
  - Paperless hook → worker: only `POST /trigger/extract`.
  - api → worker: `/trigger/extract`, `/trigger/propagate`, `/trigger/reindex-metadata`, `GET /processing`.
  - worker → api: exactly the worker principal's existing scopes (settings read, type-fields write, tenancy read/write). No other api route accepts it.
  - A valid credential calling a route outside its allowance gets **403** (not 401) and a log line naming the caller.
- **One shared check** in `@aktenraum/core`: it compares the bearer value against the known credentials in constant time and returns the caller's name. The api guards and the worker webhook both use it. `secretMatches` stays as the primitive underneath.
- **Callers show up in logs**: the worker's `webhook_enqueued` and `webhook_rejected` events carry `caller` (`paperless-hook` / `api`), and the api's internal rejections carry the caller as well.
- **Fail-closed stays**: a missing credential means calls that need it are rejected. Each service logs `service_token_unset` at startup with the names of the missing credentials. Two credentials with the same value are also treated as unset and logged (`service_token_duplicate`), because the callers would be indistinguishable.
- **Each container holds only what it needs**: compose blanks the credentials a service doesn't use, overriding the shared `docker/.env`. Paperless gets only the hook token; the api doesn't get the hook token; backup gets none.
- **BREAKING**: the `X-Aktenraum-Secret` header is no longer accepted anywhere, and `WEBHOOK_SECRET` is no longer read. There's no dual-accept window, because all three services always deploy together from one compose file. Existing `.env` files keep `WEBHOOK_SECRET` (unused) so the code can be rolled back.
- The worker e2e stack, the upgrade runbook (new step: run `bootstrap-secrets.sh`, then `up -d`), the key-rotation runbook, `docs/configuration.md`, CLAUDE.md and ADR-010 ("As built") are updated.

## Non-goals

- mTLS or signed requests. The network is internal-only; ADR-010 §7 defers this to the cloud variant.
- Personal access tokens / OAuth (ADR-010 step 6).
- Storing hashes instead of plaintext tokens in `.env`. The worker has to verify two callers, so it holds two plaintext values either way; a hash would only help if a single container's environment leaked.
- Rotating tokens automatically. Rotation means editing `.env`, then `up -d`, which the runbook documents.
- Changing the Paperless API token handling (ADR-010 §8, separate).

## Capabilities

### New Capabilities
- `auth-service-credentials`: how internal callers (Paperless hook, worker, api) authenticate to each other, what each caller may call, startup checks, and logging of the caller.

### Modified Capabilities
<!-- none: main specs are not kept in this repo; requirements are written as ADDED -->

## Impact

- **Core**: new `serviceCaller(...)` helper next to `secretMatches` (`packages/aktenraum-core/src/secrets.ts`), plus tests.
- **API**: `auth/internal.guard.ts` (`InternalGuard`, `UserOrInternalGuard` read `Authorization: Bearer`), `auto-tagger/auto-tagger.client.ts` (sends the api token), `config/settings.ts` (`SVC_TOKEN_WORKER`, `SVC_TOKEN_API`; `WEBHOOK_SECRET` dropped), `main.ts` startup check. Every test that sets `X-Aktenraum-Secret` moves to bearer credentials.
- **Worker**: `webhook.ts` (allowance per caller, 403, `caller` in logs), `config.ts`, `main.ts`; the api clients `active-model.ts`, `auto-approve-config.ts`, `home-space.ts`, `space-lookup.ts`, `type-fields.ts` and `backfill.ts` send the worker token.
- **Docker**: `docker-compose.yml` (per-service blanking, paperless `AKTENRAUM_HOOK_TOKEN`), `docker-compose.e2e.yml`, `paperless-scripts/post_consume.sh`, `.env.example`.
- **Scripts / docs**: `bootstrap-secrets.sh`, the runbooks (`upgrade-existing-install.md`, `rotate-api-keys.md`, `first-time-setup.md`, `restore.md`), `docs/configuration.md`, `docs/api-reference.md`, CLAUDE.md, ADR-010.
- **Deploy**: a live upgrade needs `bootstrap-secrets.sh`, then rebuilding and recreating all services. A post-consume hook that runs mid-upgrade with mismatched tokens only loses the webhook; the 30 s poller still picks the document up.
