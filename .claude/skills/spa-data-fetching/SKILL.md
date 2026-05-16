---
name: spa-data-fetching
description: Use when working on apps/web — adding queries, mutations, new routes, or sharing data across components. Documents the TanStack Query conventions for this codebase (query-key shape, invalidation rules, staleTime conventions, the dedup-by-key pattern for sharing data without prop drilling), the TanStack Router lazy-route + Suspense + RouteSuspense wrapper, and the SSE consumer pattern. Triggers when editing apps/web/src/lib/*.ts (data hooks), apps/web/src/routes/*.tsx (route components), apps/web/src/router.tsx, or when investigating "data is stale / why does this refetch / why doesn't this update".
---

# SPA data-fetching patterns

The SPA (`apps/web`) talks to aktenraum-api via a thin axios wrapper, with TanStack Query owning the cache layer. Every page in the SPA follows the same patterns; this is the reference.

---

## Architecture (the one-screenshot version)

```
apps/web/src/
├─ lib/
│   ├─ api.ts            ← axios instance + base URL + credentials
│   ├─ auth.ts           ← useMe / useLogout (cookie session)
│   ├─ documents.ts      ← upload/reprocess/delete/in-flight/processing/detail
│   ├─ inbox.ts          ← review queue: list, detail, approve, reject, bulk
│   ├─ library.ts        ← archive list + tag facet
│   ├─ ai.ts             ← find/answer (incl. SSE streaming)
│   ├─ settings.ts       ← LLM quality settings
│   └─ typeFields.ts     ← per-type field schemas + edits
├─ components/
│   └─ Nav.tsx, ProcessingBadge.tsx, etc.
├─ routes/
│   └─ Home.tsx, Library.tsx, Inbox.tsx, Ask.tsx, …
└─ router.tsx            ← TanStack Router routes, lazy-loaded
```

Rule of thumb: **routes never call axios directly.** Every fetch goes through a hook in `lib/*.ts`. Routes consume hooks and render. Components either consume hooks themselves (e.g. `Nav.tsx` calls `useInboxList`) or accept props from the route.

---

## Query key shape

Query keys are arrays. First element is the area (`"inbox"`, `"library"`, `"document-detail"`, `"in-flight"`), then parameters in stable order.

```typescript
// lib/inbox.ts
const INBOX_KEY = ["inbox"] as const;

useQuery({
  queryKey: [...INBOX_KEY, "list", page, pageSize, ordering],
  queryFn: () => fetchInboxList({ page, pageSize, ordering }),
  ...
});

useQuery({
  queryKey: [...INBOX_KEY, "detail", id],
  queryFn: () => fetchInboxDetail(id),
  ...
});
```

Why this shape:

- **Invalidating a whole area is one call**: `qc.invalidateQueries({queryKey: INBOX_KEY})` invalidates every inbox query.
- **Invalidating a specific shape is also one call**: `qc.invalidateQueries({queryKey: [...INBOX_KEY, "list"]})` invalidates only inbox lists, leaves detail caches alone.
- **Shared queries dedup automatically**: two components that both call `useInboxList({pageSize: 1})` produce the exact same key — TanStack Query issues one HTTP request and serves both.

The Nav badge and the "Zur Prüfung" tab badge in `Library.tsx` use this trick: both call `useInboxList({pageSize: 1})` to read `.total`, and the cache shares the result.

---

## staleTime conventions

| Kind of data | `staleTime` | `refetchInterval` | Example |
| --- | --- | --- | --- |
| Long-lived (settings, schemas, user identity) | `Infinity` or several minutes | none | `useMe`, `useTypeFieldsSchema` |
| Normal list / detail | `30_000` (30s) | none | `useInboxList`, `useLibrary` |
| Active poll (status, progress) | `staleTime: 4_000`, `refetch: 5_000` | yes | `useProcessingState` |
| Always fresh on mount | `0` | none | `useInboxDetail`, `useDocumentDetail` (forms must show server state) |
| Background badge (in-flight) | `15_000` | `30_000` | `useInFlightCount` |

Detail queries (`useInboxDetail`, `useDocumentDetail`) use `staleTime: 0` because the form on those pages needs to render the latest server values when the user navigates back to them.

When in doubt, prefer 30s `staleTime`. Aggressive `staleTime: 0` everywhere = unnecessary refetches on every navigation.

---

## Invalidation rules

After a mutation, invalidate the queries it affects. Be specific — don't invalidate the entire `INBOX_KEY` on a single-doc edit if you can invalidate just `[...INBOX_KEY, "detail", id]`.

```typescript
export function useInboxPatch(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: InboxFieldUpdate) => patchInbox(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...INBOX_KEY, "detail", id] });
      qc.invalidateQueries({ queryKey: [...INBOX_KEY, "list"] });
    },
  });
}
```

For cross-area effects, invalidate every area the action touches:

```typescript
export function useReprocess() {
  const qc = useQueryClient();
  return useMutation<ReprocessResponse, ...>({
    mutationFn: reprocessDocument,
    onSuccess: (_data, docId) => {
      qc.invalidateQueries({ queryKey: ["library"] });
      qc.invalidateQueries({ queryKey: ["inbox"] });
      qc.invalidateQueries({ queryKey: ["in-flight"] });
      qc.invalidateQueries({ queryKey: ["document-detail", docId] });
    },
  });
}
```

For bulk mutations, use `onSettled` (fires whether the mutation succeeded or failed) so the UI always re-syncs:

```typescript
onSettled: () => {
  qc.invalidateQueries({ queryKey: INBOX_KEY });
},
```

`removeQueries` (not invalidate) is right when the data is permanently gone:

```typescript
// useDeleteDocument: doc is gone, drop the detail cache entirely
qc.removeQueries({ queryKey: ["document-detail", docId] });
```

---

## Optimistic updates

We use `setQueryData` for snap-the-cache-then-confirm patterns. The cleanest example is `useDocumentFieldsPatch`:

```typescript
return useMutation<DocumentDetail, ...>({
  mutationFn: (body) => patchDocumentFields(docId, body),
  onSuccess: (data) => {
    // Snap the cache so the form re-renders with normalised values
    // (e.g. "01.12.2024" → "2024-12-01") without an extra round-trip.
    qc.setQueryData(["document-detail", docId], data);
    qc.invalidateQueries({ queryKey: ["library"] });
  },
});
```

Why `setQueryData` instead of invalidating: the server normalises values (e.g. German dates → ISO), and `setQueryData` immediately reflects the normalisation in the form without an extra GET. We still invalidate the library list because it shows the changed values in summary rows.

True optimistic updates (`onMutate` with rollback) are rarely needed in this app — the BFF is local-fast and the UX is already snappy enough.

---

## Concurrency limiting for bulk mutations

`useBulkApprove` (and the parallel `useBulkReprocess` should mirror it) caps concurrent requests with a tiny in-place limiter:

```typescript
const _BULK_APPROVE_CONCURRENCY = 4;

async function _runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function pump(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      if (item === undefined) continue;
      results[idx] = await worker(item);
    }
  }
  const lanes = Array.from(
    { length: Math.min(concurrency, items.length) },
    pump,
  );
  await Promise.all(lanes);
  return results;
}
```

Each per-row mutation costs ~3 Paperless round trips, so unbounded `Promise.all` over 50 ids would saturate Paperless's workers. Four is the empirical sweet spot.

Apply this pattern to any new bulk mutation. Don't write naked `Promise.all(ids.map(fn))` over server-touching calls.

---

## Lazy-route pattern (TanStack Router)

Every route component is `React.lazy`-imported in `router.tsx` and wrapped with `RouteSuspense`:

```typescript
import { lazy, Suspense } from "react";

const Library = lazy(() =>
  import("./routes/Library").then((m) => ({
    default: m.Library as unknown as ComponentType<{ search: LibrarySearch }>,
  })),
);

function RouteSuspense({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[40vh] items-center justify-center text-sm text-zinc-500">
          Lade…
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

const libraryRoute = createRoute({
  // ...
  component: function LibraryWrapper() {
    const search = libraryRoute.useSearch();
    return (
      <RouteSuspense>
        <Library search={search} />
      </RouteSuspense>
    );
  },
});
```

When adding a new route:

1. Create the component file under `apps/web/src/routes/MyPage.tsx` with a **named export** (not default).
2. Add the lazy import + RouteSuspense-wrapped component to `router.tsx`.
3. Add the route to `routeTree` at the bottom of `router.tsx`.
4. The Vite build will produce a separate chunk for the route — confirm with `pnpm --filter @aktenraum/web build` (target ~5-20 KB per route).

Use **named exports** for route components — the `lazy(() => import(...).then(m => ({ default: m.MyPage })))` shape relies on this. Default exports work but the named pattern keeps the file's purpose explicit when grepping.

---

## URL search params (TanStack Router)

Routes with filter / pagination state encode it in the URL via `validateSearch`:

```typescript
// router.tsx
const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library",
  beforeLoad: ({ context }) => ensureLoggedIn(context),
  validateSearch: (search: Record<string, unknown>): LibrarySearch => {
    // Coerce raw URL strings into the typed shape...
    return out;
  },
  component: function LibraryWrapper() {
    const search = libraryRoute.useSearch();  // fully typed!
    return <Library search={search} />;
  },
});
```

`validateSearch` is where you turn `?tab=review&date_from=2024-01-01&tags=foo&tags=bar` (raw strings + array) into a typed object the component consumes. Defensive coercion — drop empties, coerce numbers, normalise tags-as-string vs tags-as-string[].

When inside a route, navigate with explicit `search` to push state into the URL:

```typescript
navigate({
  to: "/library",
  search: { tab: "review" },
});

// Or merge with previous (preserve other params):
navigate({
  to: "/library",
  search: (prev) => ({ ...prev, tab: "archive" }),
});
```

URL-as-state means bookmarks work, the back button works, and refresh preserves the filter. Don't shadow URL state with React state for things that belong in the URL.

---

## SSE consumer pattern (Ask AI)

`/api/ai/answer/stream` is the only SSE endpoint. The consumer in `lib/ai.ts:streamAsk` is the reference for any future SSE work:

```typescript
export function streamAsk(question: string, handlers: StreamHandlers): AbortController {
  const controller = new AbortController();
  void (async () => {
    try {
      const resp = await fetch("/api/ai/answer/stream", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        // Read the error body for the actual reason — never just statusText.
        let detail = `${resp.status} ${resp.statusText}`;
        try {
          const body = await resp.text();
          if (body) {
            try {
              const parsed = JSON.parse(body) as { detail?: unknown };
              if (typeof parsed.detail === "string" && parsed.detail.trim()) {
                detail = parsed.detail;
              } else if (body.trim().length <= 500) detail = body.trim();
            } catch {
              if (body.trim().length <= 500) detail = body.trim();
            }
          }
        } catch { /* fall through */ }
        handlers.onError?.(detail);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n\n");
        while (idx !== -1) {
          const record = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          dispatchSseRecord(record, handlers);
          idx = buffer.indexOf("\n\n");
        }
      }
      if (buffer.trim().length > 0) dispatchSseRecord(buffer, handlers);
    } catch (err) {
      if (controller.signal.aborted) return;
      handlers.onError?.(err instanceof Error ? err.message : String(err));
    }
  })();
  return controller;
}
```

Key rules:

- **Use `fetch` + `ReadableStream`, not `EventSource`.** EventSource is GET-only; we POST the question in the body.
- **Always parse the error body** on `!resp.ok` — the user needs to see "Paperless rejected the API token" not "502 Bad Gateway".
- **Return an `AbortController`** so callers can cancel mid-stream (user navigates away, etc.).
- **Buffer across reads** — a single TCP chunk may contain a partial SSE record. Split on `\n\n` and flush the trailing partial at end-of-stream.
- **Dispatch by event type** — `meta` → `chunk*` → `final` or `error`. Each handler is optional.

The consumer side of Suspense/cancellation: when the user navigates away, the `AbortController.signal.aborted` check prevents calling `onError` for the user-initiated abort.

---

## Polling cadence

Be deliberate. Every poll is a request times every open browser tab times your user count. Defaults:

- Live processing state: 5s `refetchInterval`, 4s `staleTime`. Was 2s; reduced to halve background load.
- In-flight badge: 30s `refetchInterval`, 15s `staleTime`. Background-only feel; user doesn't notice a 30s lag.
- Upload-page task status: 1.5s (specific to upload-in-progress; high-frequency window is ≤120s).

When in doubt, lean toward longer intervals. The auto-tagger's own loops poll every 30s; the SPA doesn't need to be faster than the data source.

---

## Server type generation

The SPA's TypeScript types for API responses come from the live OpenAPI schema:

```bash
task web:types  # → pnpm --filter @aktenraum/web generate:api-types
```

This produces `apps/web/src/types/api.ts` (or similar). When a Pydantic schema in aktenraum-api changes, regen and consume the new types in the corresponding `lib/*.ts` file.

The hand-written types in `lib/*.ts` (`InboxDetail`, `DocumentDetail`, `LibraryItem`, …) currently shadow the generated types in places — drift is possible. Treat the Pydantic schema as the source of truth.

---

## Don't

- Don't call axios from inside a route component. Hooks in `lib/` only.
- Don't write naked `Promise.all(ids.map(fn))` for bulk mutations against the server. Use `_runWithConcurrency`.
- Don't set `staleTime: 0` everywhere "to be safe." It refetches on every navigation; pick a real number per query.
- Don't invalidate `["inbox"]` when you can invalidate `["inbox", "detail", id]`. Specific > broad.
- Don't use `EventSource` for SSE — we POST the question in the body, so we need `fetch`.
- Don't swallow SSE response bodies on `!resp.ok` — the user needs the actual reason.
- Don't add state to React when it belongs in the URL (filters, tabs, page). `validateSearch` is the right home.
- Don't `default export` a route component if you want lazy-import — be consistent with named exports.
- Don't use `useEffect(() => fetchSomething(), [])` for server data. That's what `useQuery` is for.
- Don't hand-write API response types without checking what `task web:types` would generate. Drift is real.
