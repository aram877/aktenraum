# ADR-008: Replace the Angular SPA with a Nuxt 4 / Vue SPA

**Status**: Accepted

**Date**: 2026-10-01

**Supersedes in part**: [ADR-007](007-nodejs-angular-migration.md) — the frontend choice only (Angular 22). ADR-007's backend decisions (TypeScript end to end, NestJS API, Node worker, one pnpm workspace) stand unchanged.

## Context

ADR-007 ported the SPA from React to Angular 22 (zoneless) as part of the move to a TypeScript-only stack. That app works: about 5k lines, 9 routes, TanStack Query, two SSE consumers (`/api/events/counts` live counts and `/api/ai/answer/stream` streamed answers), file upload, keyboard shortcuts and a responsive layout, all behind a REST/SSE contract that does not need to change.

The maintainer wants to learn Vue and Nuxt. The most effective way to learn a framework is to rebuild a real, non-trivial app in it, and `apps/web` is exactly that size. This decision is **learning-motivated**: it adds no user-facing features and was not forced by a defect in the Angular app. The constraints were therefore that behaviour stay identical (the app is used daily), the API contract stay frozen, and the existing nginx edge and its strict CSP (`script-src 'self'`) stay as they are.

The work ran as the OpenSpec change `migrate-web-to-nuxt`: the Nuxt app was built side by side in `apps/web-nuxt`, the nginx image gained a temporary build switch to bake either SPA, and the Angular app was deleted only at cutover.

## Decision

We will run the frontend as a **Nuxt 4 SPA** in `apps/web` (package `@aktenraum/web`) and delete the Angular app.

- **SPA mode, static output.** `ssr: false` in `nuxt.config.ts`; `nuxt generate` writes static files to `.output/public`, which `docker/nginx/Dockerfile` copies into the nginx image. There is no Node runtime at the edge and no Nitro server routes; the NestJS API stays the only backend. SSR was rejected because it adds a Node process to the edge, needs cookie forwarding for server-side `/api` calls, and conflicts with the static-bundle / Tauri direction of ADR-002.
- **Idiomatic Vue 3 / Nuxt**: `<script setup lang="ts">`, composables (`useApi`, `useLibrary`, `useInbox`, `useAnswerStream`, `useLiveCounts`, `useShortcuts`, …), file-based routing under `app/pages/`, `default` and `bare` layouts, named `auth` / `guest` route middleware, and client-only plugins.
- **`@tanstack/vue-query` for server state**, with the same query keys, `staleTime` values and invalidation rules as before. Reactive keys use getters or `computed`. Pinia was not added; Nuxt's `useFetch` is used only on `/health` as a deliberate learning example.
- **HTTP through `useApi()` over `$fetch`** with `baseURL: '/api'` and `credentials: 'include'`; error helpers read `FetchError` so German error text is unchanged.
- **Tailwind v4 via `@tailwindcss/vite`**, templates ported class for class to keep responsive parity mechanical.
- **Tests on Vitest + `@nuxt/test-utils`** (`environment: "nuxt"`, `mountSuspended`, `mockNuxtImport`) plus plain unit tests for pure helpers.
- **One frontend.** The temporary `WEB_APP` build arg and the `AKTENRAUM_WEB_APP` compose variable are removed; the nginx image always builds the Nuxt SPA. `task web:dev` runs the Nuxt dev server on `:4300`, proxying `/api` to nginx on `:8080` via `nitro.devProxy`. The last commit containing the Angular app is tagged `web-angular-final`.

## Consequences

**Easier**

- The maintainer gets a real Nuxt/Vue codebase that exercises pages, layouts, middleware, plugins, composables and auto-imports, which was the point.
- Less ceremony per feature than Angular: no DI providers, no zone/signal bridging, components are single `.vue` files.
- The API, worker and `@aktenraum/core` were untouched, so the backend risk of this change was zero.

**Harder, or owed**

- **CSP needed build-output work.** `nuxt generate` emits an inline import map and an inline `window.__NUXT__` config script, and Nuxt's built-in error pages inject a modulepreload polyfill. Rather than loosen `script-src 'self'`, we set `experimental.entryImportMap: false`, added `modules/external-inline-scripts.ts` (moves inline scripts into hashed `/_nuxt/boot.*.js` files at prerender time) and a custom `app/error.vue`. Only `/` is prerendered, because per-route `index.html` folders make nginx 301 `/login` → `/login/` and drop the port. Any Nuxt upgrade must be re-checked for new inline scripts.
- **The parity gate was lighter than planned.** The OpenSpec change listed an 11-point parity checklist. In practice the maintainer ran a light manual smoke test against the live stack — login/logout, upload, and Ask — and accepted the rest on the strength of the ported test suite. Regressions in the less-travelled flows (trash, settings, mobile widths, keyboard shortcuts) may surface later and should be fixed forward.
- **Auto-imports hide where things come from.** Accepted as idiomatic Nuxt; `.nuxt/imports.d.ts` shows the resolution.
- **The `spa-data-fetching` skill and all frontend docs had to be rewritten** for Vue Query and Nuxt conventions.
- **No OpenAPI codegen and no shared type import.** The SPA's interfaces are hand-written in `app/composables` / `app/utils` and must be kept in step with the API by hand.

**Reversibility**

Moderate. The cutover landed as a self-contained change, and the Angular app is recoverable from the `web-angular-final` tag. Rolling back means restoring `apps/web` from that tag and the matching Dockerfile, Taskfile and CI wiring — no data or API migration is involved.
