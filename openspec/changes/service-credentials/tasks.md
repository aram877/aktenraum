# Tasks

## 1. Shared verification (`@aktenraum/core`)

- [ ] 1.1 Add `ServiceName`, `serviceCaller(authorization, credentials)` and `checkServiceCredentials(credentials)` to `packages/aktenraum-core/src/secrets.ts` (D2: strict `Bearer <value>` parsing, compare against every credential, duplicates excluded, empty never matches) and export them from the package index; verify with new cases in `secrets.test.ts` (scheme case, missing value, array header, unknown value, duplicate, weak, unset) and `pnpm --filter @aktenraum/core test`.

## 2. Worker accepts per-caller credentials

- [ ] 2.1 Replace `WEBHOOK_SECRET` in `services/auto-tagger/src/config.ts` with `SVC_TOKEN_PAPERLESS_HOOK`, `SVC_TOKEN_API`, `SVC_TOKEN_WORKER`; log `service_token_unset` / `service_token_duplicate` / `service_token_weak` at startup in `main.ts` (no values logged); verify with a config test and by reading the startup log in the worker test for an empty config.
- [ ] 2.2 Rewrite the auth in `webhook.ts` to use `serviceCaller` and the allowance table (D3): 401 for unknown/missing credentials (`webhook_rejected reason=unknown_credential`), 403 for a known caller outside its allowance (`reason=not_allowed`, `caller`, `route`), `caller` on `webhook_enqueued`; verify with a matrix test of 3 callers × 4 routes plus unknown/missing/old `X-Aktenraum-Secret` header, and update `queue.test.ts`.
- [ ] 2.3 Make the worker's api clients (`active-model.ts`, `auto-approve-config.ts`, `home-space.ts`, `space-lookup.ts`, `type-fields.ts`, `backfill.ts`) send `Authorization: Bearer ${SVC_TOKEN_WORKER}` instead of `X-Aktenraum-Secret`; verify with the updated header assertions in `home-space.test.ts`, `space-lookup.test.ts`, `pipeline.test.ts` and `pnpm --filter @aktenraum/worker test`.

## 3. api accepts the worker credential and sends its own

- [ ] 3.1 Replace `WEBHOOK_SECRET` in `services/aktenraum-api/src/config/settings.ts` and the harness defaults with `SVC_TOKEN_WORKER` and `SVC_TOKEN_API`; log the startup check in `main.ts` (replaces `webhook_secret_unset`); verify with a settings test for the unset/duplicate cases.
- [ ] 3.2 Switch `InternalGuard` / `UserOrInternalGuard` to `serviceCaller(request.headers.authorization, { worker })` (D4: header present → must be the worker credential, else 401, never the cookie); add an `asWorker()` helper to the test harness and move `internal-guard.routes.test.ts`, `routes.test.ts`, `security.routes.test.ts`, `home-space.routes.test.ts`, `space-scoping.routes.test.ts` and `upload-space.routes.test.ts` to it; add cases for the old header → 401, the api token → 401, and a wrong bearer plus a valid cookie on type-fields → 401; verify with `pnpm --filter @aktenraum/api test` and `typecheck`.
- [ ] 3.3 Make `AutoTaggerClient` send `Authorization: Bearer ${SVC_TOKEN_API}` for triggers and `/processing`; verify with a client test asserting the header and the absence of `X-Aktenraum-Secret`.

## 4. Configuration, compose and scripts

- [ ] 4.1 Update `scripts/bootstrap-secrets.sh` to generate the three `SVC_TOKEN_*` values as `akt_svc_` + base64url(32 bytes) when empty, stop generating `WEBHOOK_SECRET`, and never delete it; update `docker/.env.example` (new keys, `WEBHOOK_SECRET` marked retired); verify by running the script twice against a scratch copy of `.env.example` (second run = no change) and checking the format with a regex.
- [ ] 4.2 Apply the per-container table in `docker/docker-compose.yml` (D5: paperless `AKTENRAUM_HOOK_TOKEN` + blank worker/api tokens, api blank hook token, backup blank all) and switch `docker/paperless-scripts/post_consume.sh` to the bearer header; verify with `docker compose --project-directory docker config` showing the expected values per service.
- [ ] 4.3 Give `docker/docker-compose.e2e.yml` three distinct tokens and add an assertion to `scripts/e2e-worker.sh` that the hook token on `/trigger/propagate` returns 403; verify with `bash scripts/e2e-worker.sh` (all assertions pass, including hook-triggered extraction).

## 5. Documentation

- [ ] 5.1 Update `docs/configuration.md`, `docs/api-reference.md` (internal endpoints: bearer credential + caller), runbooks `upgrade-existing-install.md` (new step: bootstrap-secrets → `task build` → expected log lines), `rotate-api-keys.md`, `first-time-setup.md`, `restore.md`; verify that `grep -rn "WEBHOOK_SECRET\|X-Aktenraum-Secret"` over `docs/` returns only historical or rollback mentions.
- [ ] 5.2 Add "As built (`service-credentials`)" to ADR-010 and update CLAUDE.md (the "Webhook secret" credentials row, the CSRF gotcha row, the auto-tagger webhook description, the roadmap paragraph, test counts); verify that the same grep over CLAUDE.md returns only the rollback note.

## 6. Integration

- [ ] 6.1 Run `pnpm -r lint`, `pnpm -r build`, api and web typecheck and `pnpm -r test`; verify all are green and record the new test counts.
- [ ] 6.2 Rehearse the upgrade on the throwaway e2e stack (an `.env` with only `WEBHOOK_SECRET` → `bootstrap-secrets.sh` → recreate): upload is extracted via the hook (`caller=paperless-hook`), approval propagates via the trigger (`caller=api`), and `docker inspect` of the paperless container shows no worker/api token; verify by recording the log lines in the session note.

## Workflow follow-up

- Live upgrade per the updated runbook (needs the maintainer's go-ahead): backup, `bootstrap-secrets.sh`, `task build`, then the checks from design.md "Migration Plan" step 3.
- Session note `docs/sessions/YYYY-MM-DD.md`, then archive the change with `/opsx:archive`.
