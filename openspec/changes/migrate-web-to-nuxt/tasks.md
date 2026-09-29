## 1. Scaffold and prove the build

- [x] 1.1 Scaffold `apps/web-nuxt` (Nuxt 4, `app/` srcDir), package `@aktenraum/web-nuxt`, and add it to the pnpm workspace; set `ssr: false` in `nuxt.config.ts`
- [x] 1.2 Add Tailwind v4 via `@tailwindcss/vite` and port `apps/web/src/styles.css` theme tokens into `app/assets/css/main.css`
- [x] 1.3 Add `dev` (port 4300, `/api` proxied to `:8080` via `nitro.devProxy`/`vite.server.proxy`), `build` (`nuxt generate`), `test`, `lint` scripts; add `@nuxt/eslint` config matching the repo's eslint rules
- [x] 1.4 Add `ARG WEB_APP=angular|nuxt` to `docker/nginx/Dockerfile` (build chosen package, copy its output to a common staging path) and pass `AKTENRAUM_WEB_APP` through `docker/docker-compose.yml`
- [x] 1.5 Build the nginx image with `WEB_APP=nuxt` and a placeholder page; check the generated `index.html` for inline scripts and confirm zero CSP violations in the browser console (design D10). Apply the chosen D10 fix if needed before continuing
- [x] 1.6 Add Taskfile entries `web-nuxt:dev` and make `build:fe` honour `AKTENRAUM_WEB_APP`; make sure `pnpm -r lint/build/test` and CI include the new package

## 2. Foundation

- [x] 2.1 Port pure helpers to `app/utils/` (`detailFrom`/`statusOf` over `FetchError`, `toQueryString`, lifecycle-tag helpers, `sortTagsImportantFirst`, `isFormFocused`/`shouldHandle`) with plain unit tests
- [x] 2.2 Implement `useApi()` over `$fetch` (`baseURL: '/api'`, `credentials: 'include'`, get/post/patch/put + FormData upload)
- [x] 2.3 Add `plugins/vue-query.client.ts` with the same `QueryClient` defaults as `app.config.ts`
- [x] 2.4 Implement `useAuth()` (me query on the `me` key, login/logout mutations invalidating it) and the `auth` / `guest` named middleware; port `auth-guard.spec.ts`
- [x] 2.5 Create `layouts/default.vue` (with nav) and `layouts/bare.vue` (no nav); port `Nav` + `ProcessingBadge` components including the mobile drawer; port `nav.spec.ts`
- [x] 2.6 Implement `useLiveCounts()` + `plugins/live-counts.client.ts` (open on signed-in, close on logout, 5s back-off); nav badges read from the cache entry
- [x] 2.7 Implement `useShortcuts(bindings, enabled)` with mount/unmount lifecycle

## 3. Simple pages

- [x] 3.1 `/health` using `useFetch` (bare layout, no auth); port `health.spec.ts`
- [x] 3.2 `/login` (guest middleware, bare layout); port `login.spec.ts`
- [x] 3.3 `/` Home
- [x] 3.4 Catch-all `[...slug].vue` not-found page
- [x] 3.5 `/settings`: model picker, Auto-Genehmigung, Konto sections as components; port `auto-approve.spec.ts` and `konto.spec.ts`
- [x] 3.6 `/trash`: list, restore, delete permanently, empty-trash modal; invalidation of trash + library keys

## 4. Document flows

- [x] 4.1 `useUpload()` + `/upload` page: dropzone, multi-file, task poll → status poll step machine, isolated per-file failures; port `upload.spec.ts`
- [x] 4.2 `useDocuments()` (detail, fields patch, reprocess, in-flight). The Angular app has no preview modal, star or delete, so none are ported
- [x] 4.3 `useLibrary()` with a URL-driven reactive query key + tag facets; `/library` archive tab (filters with 400ms debounce, ordering, pagination, table→cards below `md`, in-flight pin rendering); port `library.spec.ts`
- [x] 4.4 `useInbox()` incl. infinite list; `/library?tab=review` review tab with multi-select, bulk approve, "Mehr anzeigen"; port `review.spec.ts`
- [x] 4.5 `/library/[id]` two-pane review (PDF iframe + editable AI fields, Save/Reset/Reprocess/Download, PDF/Bearbeiten toggle below `lg`)
- [x] 4.6 `/inbox/[id]` review with approve/reject, auto-advance and `a`/`r`/`j`/`k`/`Esc` shortcuts; port `inbox-review.spec.ts`

## 5. Ask

- [x] 5.1 `useAnswerStream()` with the pure SSE frame parser; port `ask.spec.ts` parser cases
- [x] 5.2 `/ask` page: incremental rendering, citation cards from `final`, error state, stop button

## 6. Parity gate (maintainer, against the live stack with `AKTENRAUM_WEB_APP=nuxt`)

- [ ] 6.1 Auth: login, logout, 401 redirect, guest redirect, no nav for guests
- [ ] 6.2 Live counts: review / in-flight / trash badges update without reload; stream reconnects after `task restart`
- [ ] 6.3 Upload → review → approve → appears in library (inbox + library invalidation)
- [ ] 6.4 Library filters, ordering, pagination, URL bookmarking and back button
- [ ] 6.5 Library detail edit/save/reset/reprocess/download
- [ ] 6.6 Inbox detail keyboard shortcuts incl. "typing in a field does not approve"
- [ ] 6.7 Trash restore / delete permanently / empty
- [ ] 6.8 Ask streams incrementally and shows citations; denial answer shows no citations
- [ ] 6.9 Settings: model tier, auto-approve rules, password change
- [ ] 6.10 Mobile widths (<640, <768, <1024) on Library, detail pages, nav drawer
- [ ] 6.11 No CSP violations in the console on any route; record Angular vs Nuxt bundle sizes

## 7. Cutover

- [ ] 7.1 Tag the last Angular commit `web-angular-final`
- [ ] 7.2 Delete `apps/web` (Angular); move `apps/web-nuxt` → `apps/web` and rename the package to `@aktenraum/web`; drop the `WEB_APP` build arg and `AKTENRAUM_WEB_APP`; regenerate `pnpm-lock.yaml`
- [ ] 7.3 Confirm no `@angular/*`, `zone.js`, `rxjs` or `@tanstack/angular-query-experimental` remain in any `package.json` or the lockfile
- [ ] 7.4 Update Taskfile (`web:dev` → Nuxt), CI, and `apps/web` proxy config
- [ ] 7.5 Rewrite `.claude/skills/spa-data-fetching/SKILL.md` for Vue Query + Nuxt (reactive keys, middleware, client-only plugins, `mountSuspended` testing)
- [ ] 7.6 Write `docs/adr/008-nuxt-vue-frontend.md` and mark ADR-007 superseded for the frontend
- [ ] 7.7 Update CLAUDE.md (stack, directory layout, test counts table, SPA notes), `docs/architecture.md`, `docs/development.md`, `docs/glossary.md`
- [ ] 7.8 Run `task test` and `task lint`, rebuild with `task build:fe`, smoke-test on the live stack, then write the session note `docs/sessions/YYYY-MM-DD.md`
