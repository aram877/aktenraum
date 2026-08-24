---
name: spa-data-fetching
description: Use when working on apps/web (Angular) — adding queries, mutations, new routes, or sharing server state across components. Documents the @tanstack/angular-query-experimental conventions for this codebase (query-key shape, invalidation rules, staleTime conventions, the signal-input → computed-queryKey pattern), the zoneless change-detection consequences, lazy routes, and the SSE consumer pattern. Triggers when editing apps/web/src/app/core/*.ts (query services), apps/web/src/app/**/*.ts (route components), apps/web/src/app/app.routes.ts, or when investigating "data is stale / why does this refetch / why doesn't this update".
---

# SPA data-fetching patterns (Angular)

`apps/web` is Angular 22, **zoneless**, with TanStack Query via
`@tanstack/angular-query-experimental`. Server state lives in query services
under `src/app/core/`; components consume them and never call `fetch`
themselves.

---

## Layer split

```
src/app/core/api.ts        ← ApiClient: the ONLY place fetch() is called
src/app/core/library.ts    ← LibraryService: query/mutation factories for /api/library
src/app/core/inbox.ts      ← InboxService
src/app/library/…          ← route components: presentation + user intent
```

`ApiClient` centralises `credentials: "include"`, the JSON error unwrapping
(`{detail}` → thrown `Error`), and the 401 → login redirect. A component that
calls `fetch` directly has bypassed all three; don't.

---

## Query keys

Keys are arrays, most-general segment first, and are **exported constants**
so an invalidation site can never typo one:

```ts
export const LIBRARY_KEY = ["library"] as const;
export const INBOX_KEY = ["inbox"] as const;

// parameterised:
queryKey: [...LIBRARY_KEY, queryString]
queryKey: [...INBOX_KEY, "detail", docId]
```

Invalidating `["library"]` invalidates every parameterised child. That is the
whole point of the prefix shape — after a mutation you invalidate the area,
not each variant you can think of.

---

## Reactive keys with signals

This is the pattern that differs most from the React original. A query whose
key depends on component state takes a **function** so the signal is read
inside the reactive context:

```ts
readonly documents = injectQuery(() => ({
  queryKey: [...LIBRARY_KEY, this.queryString()],
  queryFn: () => this.api.get<LibraryList>(`/api/library/?${this.queryString()}`),
  staleTime: 30_000,
}));
```

Writing `queryKey: [...LIBRARY_KEY, this.queryString()]` outside the arrow
would snapshot the value once and the query would never refetch when filters
change — the classic symptom being "the URL updates but the table doesn't".

---

## staleTime conventions

| Data                          | staleTime | Why                                                        |
| ----------------------------- | --------- | ---------------------------------------------------------- |
| Library / inbox lists         | 30 s      | changes when the worker propagates; 30 s matches its poll   |
| Document detail               | 30 s      | same                                                        |
| Tag facets, correspondents    | 5 min     | slow-moving reference data                                  |
| Settings, auto-approve rules  | 5 min     | only this user changes them                                 |
| In-flight count, trash count  | 0 + 30 s `refetchInterval` | these ARE the live indicators      |

Anything user-editable gets invalidated on mutation success rather than a
short staleTime. Polling is for state **someone else** changes — i.e. the
worker.

---

## Mutations

```ts
readonly approve = injectMutation(() => ({
  mutationFn: (docId: number) => this.api.post(`/api/inbox/${docId}/approve`, {}),
  onSuccess: () => {
    this.queryClient.invalidateQueries({ queryKey: INBOX_KEY });
    this.queryClient.invalidateQueries({ queryKey: LIBRARY_KEY });
  },
}));
```

**Approve and reject must invalidate BOTH keys.** The document leaves the
inbox and appears in the library; invalidating only the inbox leaves a stale
library row that still shows `ai-pending` until its staleTime lapses.

---

## Routes

Every route is lazy:

```ts
{
  path: "library",
  loadComponent: () => import("./library/library").then((m) => m.Library),
}
```

Guarded routes use `canActivate: [authGuard]`. The build enforces per-route
chunking — check the bundle output after adding a route; a route that lands in
the initial chunk means something eagerly imported it.

---

## SSE (the Ask page)

`/api/ai/answer/stream` is a **POST**, so `EventSource` cannot be used — it
only does GET. The consumer uses `fetch` + a `ReadableStream` reader and parses
the `event:`/`data:` frames by hand. Events are `meta` → repeated `chunk` →
`final` (or `error`).

Two things to preserve when touching it:

- **Append to a signal, don't rebuild the string.** The answer grows token by
  token; rebuilding on every chunk is what made the React version janky.
- **Always close the reader in a `finally`.** An abandoned reader keeps the
  connection open and the server's LLM call running.

---

## Zoneless consequences

The app runs without zone.js. Two practical rules:

- **Never call `fixture.whenStable()` in tests to wait for a query.** There is
  no zone to stabilise against and it races the signal update. Use
  `expect.poll(...)` or `vi.waitFor(...)`.
- **Anything that mutates state outside Angular's knowledge must go through a
  signal.** Direct property assignment on a component won't schedule change
  detection.

(`zone.js` is present as a devDependency only because Angular's test builder
resolves `zone.js/testing` at bootstrap. The application itself stays zoneless
— do not add `provideZoneChangeDetection`.)

---

## Checklist for new data

1. ☐ Fetch goes through `ApiClient`, never a bare `fetch`
2. ☐ Query key is an exported constant array with the area prefix first
3. ☐ Key that depends on state is computed **inside** the `injectQuery` arrow
4. ☐ `staleTime` chosen from the table above, not invented
5. ☐ Mutation invalidates every area its write affects
6. ☐ New route is lazy and, if it touches user data, guarded
7. ☐ Test waits with `expect.poll`/`vi.waitFor`, not `whenStable`
