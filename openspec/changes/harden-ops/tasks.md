## 1. Edge

- [x] 1.1 `security-headers.conf` include at server + `/index.html`; verified headers on deep links and CSP-clean rendering of all SPA pages in Chrome

## 2. Compose

- [x] 2.1 Digest pins (postgres, redis, qdrant), mem limits (paperless, tika), healthchecks (redis, api, worker, nginx), `service_healthy` deps, worker grace period
- [x] 2.2 `DATABASE_URL` scheme

## 3. Builds and CI

- [x] 3.1 Dockerfile base digests, `--frozen-lockfile`
- [x] 3.2 `@qdrant/js-client-rest ~1.17.0`
- [x] 3.3 CI `images` job (verified locally: compose config, 4 builds, `nginx -t`)

## 4. Worker

- [x] 4.1 Reconcile retry (`retryUntilSuccess`) + tests; verified by restarting paperless + worker together

## 5. Verify and document

- [x] 5.1 lint, build, 646 tests, typechecks; live stack recreated, all services healthy
- [x] 5.2 CLAUDE.md, configuration.md
- [x] 5.3 Session note at commit time
