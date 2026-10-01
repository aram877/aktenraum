## ADDED Requirements

### Requirement: Security headers on every SPA response
Every HTML response of the SPA SHALL carry the CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

#### Scenario: deep link
- **WHEN** `/inbox/7` is requested
- **THEN** the response carries all four headers

### Requirement: Reproducible builds
CI and every Dockerfile SHALL install with `--frozen-lockfile`, and every external image SHALL be digest-pinned.

#### Scenario: lockfile drift
- **WHEN** a package.json changes without a lockfile update
- **THEN** CI fails at install

### Requirement: CI builds the images
CI SHALL validate the compose files, build every image and check the nginx config.

#### Scenario: broken Dockerfile
- **WHEN** a Dockerfile no longer builds
- **THEN** the `images` job fails

### Requirement: Startup reconcile survives a slow Paperless
The worker's startup index reconcile SHALL retry until Paperless answers, up to a bounded number of attempts.

#### Scenario: worker boots first
- **WHEN** the first reconcile attempt fails because Paperless is still starting
- **THEN** a later attempt completes and logs `index_reconcile_completed`
