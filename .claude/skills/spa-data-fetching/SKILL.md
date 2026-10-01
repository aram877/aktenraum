---
name: spa-data-fetching
description: Use when working on apps/web (Nuxt 4 SPA, ssr false) — adding queries, mutations, pages, middleware or plugins, or sharing server state across components. Documents the @tanstack/vue-query conventions for this codebase (query-key shape, reactive keys via getter/MaybeRefOrGetter, invalidation rules, staleTime values), the useApi-over-$fetch layer and error helpers, auth/guest named middleware, client-only plugins, default vs bare layouts, the live-counts EventSource and the Ask SSE parser, useShortcuts, URL-driven library filters, and the vitest + @nuxt/test-utils testing rules. Triggers when editing apps/web/app/composables/*.ts, apps/web/app/pages/**, apps/web/app/plugins/*.ts, apps/web/app/middleware/*.ts, apps/web/app/layouts/*.vue, apps/web/app/utils/*.ts, apps/web/nuxt.config.ts, or when investigating "data is stale / why does this refetch / why doesn't this update".
---

# SPA data-fetching patterns (Nuxt)

`apps/web` (`@aktenraum/web`) is Nuxt 4 with `ssr: false`, built by
`nuxt generate` into static files that nginx serves. Server state lives in
`@tanstack/vue-query`; there is no Pinia and no Nitro server code. Rationale:
`openspec/changes/migrate-web-to-nuxt/design.md` (D3–D9).

Everything under `app/composables/` and `app/utils/` is auto-imported;
`.nuxt/imports.d.ts` shows where a name resolves from.

---

## Layer split

```
app/composables/useApi.ts      <- the ONLY wrapper around $fetch (baseURL /api, credentials)
app/composables/useLibrary.ts  <- query/mutation composables per area (useInbox, useTrash, ...)
app/utils/*.ts                 <- pure helpers: errors, sse, library, keyboard, ...
app/pages/**.vue               <- presentation + user intent; call composables, never $fetch
```

`useApi()` returns `{ get, post, patch, put, upload }` built on
`$fetch.create({ baseURL: "/api", credentials: "include" })`, so paths are
written **without** the `/api` prefix (`api.get("/library/tags")`). `upload`
sends a `FormData` body; there is no byte progress, the upload page uses a
phase machine instead (`useUploadTracker`).

Exceptions that deliberately bypass `useApi`:

- `useAnswerStream` uses raw `fetch` because it needs `resp.body.getReader()`.
- `pages/health.vue` uses Nuxt `useFetch("/api/health", { key: "health" })`
  as the one intentional learning example. Do not spread `useFetch` further;
  it has no mutation/invalidation model.

### Errors

`$fetch` throws a `FetchError`. Never read it by hand; use `utils/errors.ts`:

- `detailFrom(error, fallback)` — the `{detail}` string (or the first
  `detail[].msg`), `"Server nicht erreichbar."` when there is no status,
  otherwise `"<status> <statusMessage>"`.
- `statusOf(error)` — the HTTP status or `null`.

---

## Query keys

Keys are arrays, area segment first. Shared prefixes are exported constants:

```ts
export const ME_KEY = ["me"] as const;
export const INBOX_KEY = ["inbox"] as const;
export const TRASH_KEY = ["trash"] as const;
export const LIVE_COUNTS_KEY = ["live", "counts"] as const;
export const LLM_KEY = ["settings", "llm"] as const;          // also ANSWER_LLM_KEY, AVAILABLE_MODELS_KEY, AUTO_APPROVE_KEY
export const DOCUMENT_DETAIL_KEY = "document-detail";         // used as [DOCUMENT_DETAIL_KEY, id]

queryKey: [...INBOX_KEY, "detail", id]
queryKey: [...INBOX_KEY, "list-infinite", pageSize, ordering]
queryKey: ["library", query]                                   // query object, not a string
```

`["library"]`, `["library-tags"]` and `["in-flight"]` are still literals in
`useLibrary.ts` / `useDocuments.ts`. Invalidating `["library"]` hits every
`["library", …]` child, which is the point of the prefix shape. Note
`["library-tags"]` is a separate root and is NOT invalidated by `["library"]`.

---

## Reactive keys

A query whose key depends on reactive state passes a **getter of options** to
`useQuery`, and takes its inputs as `MaybeRefOrGetter`, unwrapped with
`toValue` inside the getter:

```ts
export function useLibrary(query: MaybeRefOrGetter<LibraryQuery>) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: ["library", toValue(query)],
    queryFn: () => api.get<LibraryList>(`/library/?${toQueryString({ ...toValue(query) })}`),
    staleTime: 15_000,
  }));
}
```

Callers pass a `computed`, a ref or a getter (`() => detail.isSuccess.value`).
Passing a plain value (`useLibrary(query.value)`) snapshots it once and the
query never refetches — symptom: "the URL updates but the table doesn't".
`enabled` follows the same rule (`enabled: toValue(id) !== null`).

Composables that need no reactive input (`useTagFacet`, settings queries,
`useInboxListInfinite`) pass a plain options object.

---

## staleTime values

Global defaults (`plugins/vue-query.client.ts`): `staleTime: 30_000`,
`retry: 1`, `refetchOnWindowFocus: false`.

| Data                                         | staleTime | Extra                                  |
| -------------------------------------------- | --------- | -------------------------------------- |
| `me`                                         | 60 s      | `retry` < 2; 401 resolves to `null`    |
| Library list                                 | 15 s      |                                        |
| Trash list                                   | 15 s      |                                        |
| Inbox detail / list, document detail         | 30 s      |                                        |
| Inbox infinite list (review tab)             | 30 s      | `refetchOnWindowFocus: true`           |
| LLM / answer-LLM settings, auto-approve rules| 30 s      |                                        |
| Available models                             | 10 s      |                                        |
| Tag facet (`library-tags`)                   | 5 min     |                                        |
| In-flight count                              | 15 s      | `refetchInterval: 30_000`              |
| Live counts                                  | Infinity  | `enabled: false`, filled by SSE        |

Pick from this table, do not invent new values. User-editable data is
invalidated or `setQueryData`'d on mutation success; polling is only for state
someone else (the worker) changes.

---

## Mutations and invalidation

```ts
export function useApprove(id: MaybeRefOrGetter<number | null>) {
  const api = inboxApi(useApi());
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body?: InboxFieldUpdate) => api.approve(toValue(id) as number, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INBOX_KEY });
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
}
```

Rules the code follows:

- **Approve, reject and bulk approve invalidate BOTH `inbox` and `library`.**
  The doc leaves the review queue and appears in the archive. Bulk approve
  does it in `onSettled` so partial failures still refresh.
- Reprocess invalidates `library`, `inbox` and `[DOCUMENT_DETAIL_KEY, id]`.
- Field PATCH writes the response into `[DOCUMENT_DETAIL_KEY, id]` with
  `setQueryData`, then invalidates `library`.
- Restore / delete forever / empty trash invalidate `trash` and `library`.
- Settings mutations `setQueryData` their own key from the response (no refetch).
- Login sets `ME_KEY` to the user; logout (`onSettled`) and change-password set
  it to `null`, which also stops the live-counts stream.

Fire-and-forget invalidation uses `void queryClient.invalidateQueries(...)`.

---

## Routing, middleware, layouts

Pages are file-based under `app/pages/` (`library/index.vue`,
`library/[id].vue`, `inbox/[id].vue`, `[...slug].vue` for 404). Nuxt splits
each page into its own chunk; nothing to configure.

Auth is **named** middleware, opted into per page:

```ts
definePageMeta({ middleware: "auth" });                    // every user-data page
definePageMeta({ layout: "bare", middleware: "guest" });   // login
definePageMeta({ layout: "bare" });                        // health
```

- `middleware/auth.ts` does `$queryClient.fetchQuery({ ...meQuery(useApi()), retry: false })`
  and `navigateTo("/login")` on `null`. Because it goes through the cache, a
  fresh `me` (60 s) is not refetched on every navigation. A non-401 error is
  rethrown, so an outage is never mistaken for a logout.
- `middleware/guest.ts` sends an authenticated user to `/` and swallows errors.
- A new page touching user data MUST declare `middleware: "auth"`; nothing is
  global.
- `layouts/default.vue` renders `<AppNav />`; `layouts/bare.vue` has no nav.
  Unauthenticated pages use `bare` so visitors never see the nav.

---

## Plugins (client-only)

Both plugins are `*.client.ts` (SPA, never on a server):

- `plugins/vue-query.client.ts` (`name: "vue-query"`) creates the
  `QueryClient`, installs `VueQueryPlugin` and provides it as
  `useNuxtApp().$queryClient`. Use `$queryClient` outside components
  (middleware, plugins); use `useQueryClient()` inside composables.
- `plugins/live-counts.client.ts` (`dependsOn: ["vue-query"]`) subscribes a
  `QueryObserver` on `ME_KEY` (`enabled: false`, it only watches) and calls
  `stream.start()` when a user is present, `stream.stop()` when `me` is null.

---

## Live counts (EventSource)

`createLiveCountsStream(queryClient)` in `composables/useLiveCounts.ts` owns
one credentialed `EventSource("/api/events/counts")`. Each message is
`setQueryData(LIVE_COUNTS_KEY, …)`; on error it closes and reconnects after
`LIVE_RECONNECT_DELAY_MS` (5 s), with at most one pending retry. `start` is
idempotent; `stop` clears the timer and closes the source.

Consumers read it with `useLiveCounts()` (`enabled: false`,
`staleTime: Infinity`, queryFn returns `null`). `AppNav` prefers live values
and falls back to the polled queries (`useInFlightCount`, `useTrashList`,
`useInboxList({ pageSize: 1 })`, all gated on `authenticated`), so the badges
still work if the stream is down.

---

## Ask SSE (`/api/ai/answer/stream`)

The endpoint is a **POST**, so `EventSource` cannot be used. `useAnswerStream`
calls `fetch` with `credentials: "include"` and an `AbortController`, then
hands `resp.body` to `readSseStream` in `utils/sse.ts`, which splits on
`\n\n` and calls the pure `dispatchSseRecord(record, handlers)`. Events:
`meta` → repeated `chunk` (`{text}`) → `final` (`{answer_de, citations}`) or
`error` (`{detail}`). A non-OK response goes through `extractErrorDetail`.

When touching it:

- `onChunk` appends to the `answer` ref (`answer.value += delta`); `onFinal`
  replaces it with the authoritative `answer_de`.
- `ask()` aborts any previous controller; `onBeforeUnmount` aborts too, so a
  navigated-away page never keeps the server's LLM call running. An abort is
  not reported as an error.
- Keep `dispatchSseRecord` / `extractErrorDetail` pure; they are unit-tested
  without the Nuxt environment.

---

## Keyboard shortcuts

```ts
useShortcuts(
  () => ({ a: () => void onApprove(), r: () => void onReject(), j: next, k: prev, Escape: back }),
  () => detail.isSuccess.value,
);
```

Bindings are a getter (re-read on each keydown, so they see current state);
`enabled` is `MaybeRefOrGetter<boolean>`. The listener is added in
`onMounted` and removed in `onBeforeUnmount`. `shouldHandle` (`utils/keyboard.ts`)
ignores keys while an input/textarea/select/contenteditable is focused or a
meta/ctrl/alt modifier is held.

---

## URL-driven library filters

`pages/library/index.vue` keeps all filter state in `route.query`:

- `filters` is a `computed` over `route.query` using `firstParam` /
  `allParams` (`utils/library.ts`); `query` is a `computed<LibraryQuery>`
  passed straight to `useLibrary(query)`. The URL is the single source of truth.
- Changes go through `navigateTo({ path: "/library", query: cleanLibraryQuery({...}) })`,
  which drops empty values, `page=1` and the default ordering (`-created`) so
  URLs stay short and bookmarkable. Any filter change resets `page` to 1.
- Free text is copied into a local ref and pushed to the URL after a 400 ms
  debounce; the timer is cleared in `onBeforeUnmount`.
- `?tab=review` switches to `components/library/ReviewTab.vue`
  (`useInboxListInfinite`, load-more pagination).

---

## Testing

`vitest.config.ts` uses `defineVitestConfig` with `environment: "nuxt"` and
happy-dom. Run with `pnpm --filter @aktenraum/web test`.

- `tests/unit/` — pure helpers (`errors`, `sse`, `library`, `review-form`, …);
  import from `~/utils/...` explicitly.
- `tests/nuxt/` — pages, components, middleware and composables, rendered with
  `mountSuspended` from `@nuxt/test-utils/runtime` (auto-imports, router and
  the vue-query plugin are live).
- Mock the HTTP layer with `mockNuxtImport("useApi", () => () => ({ get, post, patch: vi.fn(), put: vi.fn(), upload: vi.fn() }))`,
  with the `vi.fn`s created in `vi.hoisted`. `mockNuxtImport("navigateTo", …)`
  for middleware tests. `registerEndpoint` only for the `useFetch` health page
  (pair with `clearNuxtData("health")`).
- Build fetch errors with `tests/fetch-error.ts` `fetchError(status, data, statusMessage)`.
- Reset shared cache in `beforeEach`: `useNuxtApp().$queryClient.clear()`.
- Wait with `vi.waitFor(...)` or `flushPromises()`. Use `vi.useFakeTimers()`
  for polling/back-off (upload tracker, live-counts reconnect); stub
  `EventSource` with `vi.stubGlobal`.
- Composables with lifecycle hooks (`useShortcuts`) are tested through a small
  `defineComponent` harness mounted with `@vue/test-utils` `mount`.

---

## Checklist for new data

1. HTTP goes through `useApi()` (path without `/api`); errors through `detailFrom`/`statusOf`
2. Query key starts with the area segment; shared prefixes are exported constants
3. Reactive inputs are `MaybeRefOrGetter`, read with `toValue` inside `useQuery(() => ({...}))`
4. `staleTime` taken from the table above
5. Mutation invalidates (or `setQueryData`s) every area its write affects
6. New page declares `middleware: "auth"` if it shows user data; `layout: "bare"` if unauthenticated
7. Anything browser-only that runs at startup is a `*.client.ts` plugin
8. Test mocks `useApi` via `mockNuxtImport`, clears `$queryClient`, waits with `vi.waitFor`
