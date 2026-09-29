## Context

`apps/web` is an Angular 22 zoneless SPA (about 5.2k lines of TS + templates, 11 spec files) that ADR-007 introduced when it replaced the React app. It talks only to same-origin `/api/*` (NestJS behind nginx), authenticates with an httpOnly JWT cookie, uses `@tanstack/angular-query-experimental`, and has two streaming paths: `EventSource` on `/api/events/counts` and a `fetch` + `ReadableStream` reader on `/api/ai/answer/stream`. nginx bakes the built SPA into its image and enforces a strict CSP (`script-src 'self'`).

This change rebuilds the same app in Nuxt/Vue. The main goal is learning, so the design should use idiomatic Nuxt/Vue patterns rather than copy Angular structure line for line. It also has to keep behavior identical, because the maintainer uses the app every day.

## Goals / Non-Goals

**Goals:**
- Full behavioral parity with the Angular SPA against an unchanged API.
- Idiomatic Vue 3 / Nuxt 4: `<script setup lang="ts">`, composables, file-based routing, route middleware, auto-imports.
- Each Nuxt concept should appear at least once in real code (pages, layouts, middleware, plugins, composables, `useRuntimeConfig`, `<ClientOnly>` where relevant), so the codebase is a useful reference.
- Zero downtime and a one-line rollback until cutover.

**Non-Goals:**
- SSR, SSG with prerendered data, Nitro server routes, or a Node runtime in production. The NestJS API stays the only backend.
- UI redesign, new features, or copy changes.
- A component library (Nuxt UI, PrimeVue, Vuetify). We stay on plain Tailwind to match the current markup.
- Pinia. Server state is in Vue Query; the little client state there is (drawer open, tab) stays local or in the URL.
- Changes to the API contract, the worker, or `@aktenraum/core`.

## Decisions

### D1. Nuxt with `ssr: false` + `nuxt generate`, not plain Vite + Vue
Nuxt is what the maintainer wants to learn. With SSR off it acts as a Vue SPA framework: file-based routing, layouts, middleware and auto-imports. `nuxt generate` writes static files to `.output/public`, which nginx serves the way it serves the Angular `dist/` today.
- *Alternative: Vite + Vue + vue-router.* Smaller and closer to the metal, but it skips the Nuxt conventions, which are the point of this change.
- *Alternative: SSR with a Nitro server behind nginx.* Adds a Node runtime at the edge, needs cookie forwarding for server-side `/api` calls, and conflicts with the Tauri/static-bundle direction (ADR-002). Rejected.

### D2. Build side by side in `apps/web-nuxt`, rename at cutover
A new workspace package lets both apps build, test and run in dev at the same time, and makes parity easy to check by opening them next to each other. At cutover it moves to `apps/web` and takes the `@aktenraum/web` name, so Taskfile/CI/Dockerfile paths return to their current form.
- *Alternative: replace `apps/web` in place.* Leaves the app broken until the port is finished, with no side-by-side comparison. Rejected.

### D3. `@tanstack/vue-query` for server state
This is the direct counterpart of the current library. Query keys, `staleTime` and invalidation rules carry over one to one, so the `spa-data-fetching` skill mostly survives with new syntax. Reactive keys use a getter or `computed` inside `queryKey` (`queryKey: ['library', () => route.query]` or `computed(() => [...])`). This replaces the Angular signal-input → computed-queryKey pattern.
- The `QueryClient` is created in `plugins/vue-query.client.ts` with the same defaults as `app.config.ts` (staleTime 30s, retry 1, refetchOnWindowFocus false).
- *Alternative: Nuxt's built-in `useFetch`/`useAsyncData`.* Worth learning, but it has no mutation/invalidation model comparable to what the app relies on (bulk approve, infinite review list, cache seeding from SSE). We use it only in the `/health` page, as a deliberate learning example.
- *Alternative: Pinia + hand-rolled fetching.* Would have to re-implement caching and invalidation. Rejected.

### D4. HTTP layer: a `useApi()` composable over `$fetch`
`$fetch` (ofetch) is Nuxt's native client. `useApi()` wraps it with `baseURL: '/api'` and `credentials: 'include'`, and exposes `get/post/patch/put`. `detailFrom(error)` and `statusOf(error)` are ported to work on `FetchError` (`error.data?.detail`, `error.statusCode`). Error text (German strings included) stays identical.
- Uploads use `$fetch` with a `FormData` body. Neither client reports upload progress, so per-file state keeps today's step machine (upload → task poll → status poll) rather than byte progress.

### D5. Auth as named route middleware, not global
`middleware/auth.ts` and `middleware/guest.ts` call `GET /api/auth/me` through Vue Query (`queryClient.fetchQuery` on the `me` key), so navigating between pages reuses the cached result within its staleTime instead of refetching on every route change. Pages opt in with `definePageMeta({ middleware: 'auth' })`. Using named middleware keeps `/health` and `/login` explicit and teaches `definePageMeta`.
- Layouts: `layouts/default.vue` renders the nav and `layouts/bare.vue` is used by `/login` and `/health`. This gives structurally the same fix as commit `1ec778d` (no nav for unauthenticated visitors).

### D6. SSE as client-only composables started from a plugin
- `composables/useLiveCounts.ts` owns one `EventSource` per app session with the same 5s manual back-off. It writes into the query cache with `setQueryData`, and consumers read it with `useQuery({ enabled: false, staleTime: Infinity })`, the same approach as `live.ts`. It is started from `plugins/live-counts.client.ts` watching the `me` query: opened when a user is present, closed on logout.
- `composables/useAnswerStream.ts` ports the `fetch` + `getReader()` SSE parser. The frame-parsing function stays a pure function so the existing `ask.spec.ts` cases can be ported directly.

### D7. Keyboard shortcuts as `useShortcuts(bindings, enabled)`
A composable that registers `keydown` in `onMounted` and removes it in `onBeforeUnmount`, reusing the pure `isFormFocused`/`shouldHandle` helpers. This is the Vue lifecycle counterpart of the `DestroyRef` pattern.

### D8. Tailwind v4 through `@tailwindcss/vite`
Registered in `nuxt.config.ts` under `vite.plugins`, with `css: ['~/assets/css/main.css']` holding `@import "tailwindcss"` and the current `styles.css` theme tokens. Templates are ported class for class, which keeps responsive parity mechanical.
- *Alternative: `@nuxtjs/tailwindcss` module.* It lagged behind v4 and adds an indirection we do not need.

### D9. Testing: Vitest + `@nuxt/test-utils` (`environment: 'nuxt'`) + `@vue/test-utils`
`mountSuspended` renders components with auto-imports and the router available. `registerEndpoint` / `vi.fn` stubs replace `HttpTestingController`. Pure helpers (`toQueryString`, SSE frame parser, `detailFrom`, `shouldHandle`) get plain unit tests with no Nuxt environment. One Vue test file per Angular spec, keeping the same scenarios.

### D10. CSP: keep `script-src 'self'`, fix the build output instead
In SPA mode, Nuxt's generated `index.html` normally contains an inline `<script>` carrying `window.__NUXT__` config/payload, and `script-src 'self'` blocks it. Options, in order of preference:
1. Check whether current Nuxt emits the config as `<script type="application/json">` (a data block, not executed and not blocked). If only JSON data blocks remain, no change is needed.
2. Otherwise add a small post-generate step (or a Nitro `render:html` hook at generate time) that moves the inline script into a hashed `.js` file referenced by `src`.
3. As a last resort, add that script's `sha256-…` hash to the CSP in `nginx.conf`, computed at image build time.
Loosening the CSP to `'unsafe-inline'` is not allowed. The first task after scaffolding is to verify this against the nginx image, because it could block the whole approach.

### D11. nginx image selects the SPA with `ARG WEB_APP=angular|nuxt`
The builder stage builds the chosen package and copies its output to one staging path (`/out`). The runtime stage copies `/out` into the nginx html root. `nginx.conf` is untouched: the `try_files … /index.html` fallback works for Nuxt's client router as it does for Angular's. The compose file passes the arg through `AKTENRAUM_WEB_APP` (default `angular` until cutover, then the arg is removed).

### D12. Directory layout (Nuxt 4 `app/` srcDir)
```
apps/web-nuxt/
├── nuxt.config.ts
├── app/
│   ├── app.vue
│   ├── layouts/        default.vue, bare.vue
│   ├── pages/          index, login, ask, upload, trash, settings, health,
│   │                   library/index, library/[id], inbox/[id], [...slug]
│   ├── components/     Nav, ProcessingBadge, DocumentPreviewModal, settings/*, library/*
│   ├── composables/    useApi, useAuth, useLibrary, useInbox, useDocuments, useTrash,
│   │                   useSettings, useUpload, useAnswerStream, useLiveCounts, useShortcuts
│   ├── middleware/     auth.ts, guest.ts
│   ├── plugins/        vue-query.client.ts, live-counts.client.ts
│   ├── utils/          lifecycle-tags.ts, query-string.ts, errors.ts   (pure, auto-imported)
│   └── assets/css/main.css
└── tests/              mirrors app/ where needed
```

## Risks / Trade-offs

- [CSP blocks Nuxt's inline bootstrap script] → D10. Verified in the first task, before any page is ported.
- [Vue Query reactive-key mistakes: a plain value instead of a ref/getter makes a query stop reacting to filter changes] → Parity test on the Library filter → request path. Document the rule in the updated `spa-data-fetching` skill.
- [Parity drift while both apps exist: a fix lands in Angular and not in Nuxt] → Freeze Angular feature work for the duration. Bug fixes go into both apps until cutover.
- [Test count drops at cutover (Angular's 79 web tests) and CLAUDE.md numbers go stale] → Tasks include recounting and updating the tables in CLAUDE.md.
- [Nuxt auto-imports hide where things come from, which hurts learning] → Accepted on purpose (it is idiomatic Nuxt). `.nuxt/imports.d.ts` shows the resolution. Pure utils are also imported explicitly in tests.
- [Bundle size grows versus Angular] → Not a goal. Record both sizes in the session note for comparison.

## Migration Plan

1. Scaffold `apps/web-nuxt`, wire it into workspace/CI/Taskfile, and prove the CSP-clean static build in the nginx image (`WEB_APP=nuxt`).
2. Port the foundation (API, auth, layouts, Vue Query, live counts), then pages in increasing complexity: health → login → home → settings → trash → upload → library → library detail → inbox detail → ask.
3. Use the Nuxt build locally (`AKTENRAUM_WEB_APP=nuxt task build:fe`) on the live stack and work through the parity checklist.
4. Cutover: delete Angular, rename the package/path, drop the build arg, update docs/skill/ADR, session note.

**Rollback:** before step 4, rebuild with `AKTENRAUM_WEB_APP=angular`. After step 4, `git revert` the cutover commit. It is self-contained because the cutover lands as one commit.

## Open Questions

- Keep the Angular app in a `learning/` branch or tag after deletion for later comparison? Default: tag the last commit with Angular as `web-angular-final`.
- Should `/health` use `useFetch` (D3 learning example) or Vue Query for consistency? Default: `useFetch`, with a short README note in the package explaining the difference.
