## Why

The SPA was just ported from React to Angular 22 (ADR-007). The maintainer now wants to learn Vue and Nuxt, and the best way to learn a framework is to rebuild a real, non-trivial app with it. `apps/web` works for this: about 5k lines, 9 routes, TanStack Query, SSE streaming, file upload, keyboard shortcuts, and a responsive layout, all behind a stable REST/SSE contract that does not have to change. This change is **for learning**. It adds no user-facing features, and the Angular app is only deleted once the Nuxt app reaches full parity.

## What Changes

- Add a new Nuxt 4 app (Vue 3, `<script setup>` + Composition API, TypeScript) at `apps/web-nuxt`, package `@aktenraum/web-nuxt`, in the existing pnpm workspace.
- Run it as a client-rendered SPA (`ssr: false`), built with `nuxt generate` into static files that nginx serves. Keep the same-origin `/api/*` reverse proxy, the cookie auth, and the CSP.
- Port every current route to Nuxt file-based routing: `/login`, `/` (Home), `/ask`, `/library` (archive and review tabs), `/library/[id]`, `/inbox/[id]`, `/upload`, `/trash`, `/settings`, `/health`, plus a catch-all 404.
- Replace `@tanstack/angular-query-experimental` with `@tanstack/vue-query`. Keep the same query keys, `staleTime` values and invalidation rules.
- Replace Angular services and guards with Vue composables (`useApi`, `useLibrary`, `useInbox`, …) and Nuxt route middleware (`auth`, `guest`).
- Port the SSE consumers (`/api/events/counts` live counts, `/api/ai/answer/stream` streamed answers) to client-only composables with the same reconnect/back-off behavior.
- Tailwind v4 through `@tailwindcss/vite`, with the same breakpoints and responsive behavior.
- Tests use Vitest + `@nuxt/test-utils` + `@vue/test-utils`. Every existing Angular spec gets a Vue equivalent.
- Add an nginx build switch so the edge image can bake either SPA while both exist. The default flips to Nuxt at cutover.
- **BREAKING (internal, at cutover only)**: delete `apps/web` (Angular), its dependencies, and its Taskfile/CI wiring. Rename `apps/web-nuxt` → `apps/web` and the package to `@aktenraum/web`. Replace the `spa-data-fetching` skill's Angular content with Vue Query conventions.
- Record the decision in a new ADR (`docs/adr/008-nuxt-vue-frontend.md`) that supersedes the frontend part of ADR-007.

## Capabilities

### New Capabilities

- `nuxt-web-spa`: the Nuxt/Vue SPA: route parity, auth middleware, data-fetching parity (query keys, invalidation, staleTime), SSE consumption, responsive parity, keyboard shortcuts, static build served by nginx under the existing CSP.
- `frontend-cutover`: running both SPAs side by side through an nginx build switch, the parity gate that must pass before cutover, and removing the Angular app.

### Modified Capabilities

<!-- None: there is no openspec/specs/ baseline yet. The Angular SPA's requirements live only in the in-flight rewrite-stack-nodejs-angular change and are superseded by nuxt-web-spa. -->

## Impact

- **Code**: new `apps/web-nuxt/`. `apps/web/` is deleted at cutover. No change to `services/*` or `packages/aktenraum-core`, and no API contract change.
- **Dependencies**: adds `nuxt`, `vue`, `vue-router` (via Nuxt), `@tanstack/vue-query`, `@nuxt/test-utils`, `@vue/test-utils`, `@nuxt/eslint`, `tailwindcss` + `@tailwindcss/vite`. Removes all `@angular/*`, `rxjs`, `zone.js` and `@tanstack/angular-query-experimental` at cutover.
- **Build/deploy**: `docker/nginx/Dockerfile` gains a build arg to pick the SPA and copies `.output/public` for Nuxt. `nginx.conf` SPA fallback is unchanged. The CSP `script-src 'self'` must hold against Nuxt's generated `index.html` (see design).
- **Tooling**: `Taskfile.yml` (`web:dev`, `build:fe`, `test`, `lint`), `.github/workflows/ci.yml`, root `pnpm -r` scripts, and `.claude/skills/spa-data-fetching/SKILL.md`.
- **Docs**: CLAUDE.md (stack description, directory layout, test counts, SPA notes), `docs/architecture.md`, `docs/development.md`, `docs/glossary.md` (Vue/Nuxt terms), the new ADR-008, and a session note.
- **Risk**: low for users. The Angular app keeps serving until parity is verified, and rolling back is one build arg.
