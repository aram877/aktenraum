## 1. Infra

- [x] 1.1 Qdrant API key (compose, clients, bootstrap-secrets, e2e)
- [x] 1.2 Unprivileged nginx (8080) and Qdrant; cap_drop / no-new-privileges

## 2. API

- [x] 2.1 Password-bound sessions; login throttle; constant-time unknown user
- [x] 2.2 Fail-closed secret; CSRF bypass by value; type-fields session check
- [x] 2.3 Disk-backed uploads; attachment + sandbox for non-PDF streams
- [x] 2.4 Tests (`security.routes.test.ts`)

## 3. Worker

- [x] 3.1 Fail-closed webhook secret

## 4. Backup

- [x] 4.1 DB first, tar stream for files, restic 0.18, freshness healthcheck, verify asserts originals
- [x] 4.2 bootstrap-secrets carries legacy secrets, guards the restic password
- [x] 4.3 Restored the live RESTIC_PASSWORD; first complete snapshot + `verify-backup.sh` PASS

## 5. Verify and document

- [x] 5.1 lint, build, 652 tests; live stack healthy; Ask via keyed Qdrant
- [x] 5.2 e2e (20/20 with the Qdrant key)
- [x] 5.3 CLAUDE.md, configuration.md, restore runbook
- [x] 5.4 Session note at commit time
