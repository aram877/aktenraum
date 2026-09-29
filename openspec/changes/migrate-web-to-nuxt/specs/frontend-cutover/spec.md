## ADDED Requirements

### Requirement: Selectable SPA at image build time
Until cutover, the nginx image SHALL accept a build argument choosing which SPA to bake (`angular` or `nuxt`). The `/api/*` proxy, security headers and SPA history fallback SHALL be identical for both.

#### Scenario: Building the Nuxt variant
- **WHEN** the nginx image is built with the SPA build argument set to `nuxt`
- **THEN** the image serves the Nuxt static output at `/` and proxies `/api/*` to `aktenraum-api` exactly as before

#### Scenario: Rolling back before cutover
- **WHEN** the nginx image is rebuilt with the argument set to `angular`
- **THEN** the Angular SPA is served again with no other change

### Requirement: Parallel local development
Both SPAs SHALL be runnable in dev mode at the same time on different ports, each proxying `/api` to the nginx edge on `:8080`.

#### Scenario: Both dev servers side by side
- **WHEN** the Angular dev server and the Nuxt dev server run at the same time
- **THEN** each serves on its own port and both can sign in against the same running stack

### Requirement: Parity gate before cutover
The Angular app SHALL NOT be deleted until every `nuxt-web-spa` requirement has been checked against the live stack by the maintainer, the Nuxt test suite passes, and the parity checklist in `tasks.md` is fully ticked.

#### Scenario: Incomplete parity blocks deletion
- **WHEN** any parity checklist item is unticked
- **THEN** the Angular removal tasks are not started

### Requirement: Angular removal at cutover
At cutover, `apps/web` (Angular) and its dependencies SHALL be deleted, the Nuxt app SHALL take over the `apps/web` path and the `@aktenraum/web` package name, the nginx build argument SHALL be removed, and Taskfile, CI, CLAUDE.md, the `spa-data-fetching` skill and the docs SHALL describe only the Nuxt app.

#### Scenario: No Angular left after cutover
- **WHEN** cutover is complete
- **THEN** no `@angular/*`, `zone.js` or `@tanstack/angular-query-experimental` dependency remains in any `package.json` or in `pnpm-lock.yaml`

### Requirement: Decision recorded
The switch SHALL be recorded in `docs/adr/008-nuxt-vue-frontend.md`, which states the learning motivation and supersedes the frontend part of ADR-007.

#### Scenario: ADR exists at cutover
- **WHEN** the Angular app is removed
- **THEN** ADR-008 exists and ADR-007 links to it as superseded for the frontend
