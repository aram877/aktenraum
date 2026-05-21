import { lazy, Suspense, type ComponentType } from "react";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";

// Lazy route components. Splitting at the route boundary cuts the
// initial bundle ~60%: a user who only opens /library never downloads
// the SettingsPage, InboxReview, Ask, etc. The Suspense fallback below
// renders during the per-chunk fetch — under 100ms on a warm cache.
const Ask = lazy(() => import("./routes/Ask").then((m) => ({ default: m.Ask })));
const Find = lazy(() =>
  import("./routes/Find").then((m) => ({ default: m.Find })),
);
const Home = lazy(() =>
  import("./routes/Home").then((m) => ({ default: m.Home })),
);
const InboxReview = lazy(() =>
  import("./routes/InboxReview").then((m) => ({ default: m.InboxReview })),
);
const Library = lazy(() =>
  import("./routes/Library").then((m) => ({
    default: m.Library as unknown as ComponentType<{ search: LibrarySearch }>,
  })),
);
const LibraryReview = lazy(() =>
  import("./routes/LibraryReview").then((m) => ({ default: m.LibraryReview })),
);
const Login = lazy(() =>
  import("./routes/Login").then((m) => ({ default: m.Login })),
);
const Scan = lazy(() =>
  import("./routes/Scan").then((m) => ({ default: m.Scan })),
);
const SettingsPage = lazy(() =>
  import("./routes/Settings").then((m) => ({ default: m.SettingsPage })),
);
const Trash = lazy(() =>
  import("./routes/Trash").then((m) => ({ default: m.Trash })),
);
const Upload = lazy(() =>
  import("./routes/Upload").then((m) => ({ default: m.Upload })),
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

import { fetchMe } from "./lib/api";
import type { QueryClient } from "@tanstack/react-query";

interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
});

async function ensureLoggedIn(context: RouterContext) {
  try {
    await context.queryClient.fetchQuery({
      queryKey: ["me"],
      queryFn: fetchMe,
    });
  } catch {
    throw redirect({ to: "/login" });
  }
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: ({ context }) => ensureLoggedIn(context),
  component: () => (
    <RouteSuspense>
      <Home />
    </RouteSuspense>
  ),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: () => (
    <RouteSuspense>
      <Login />
    </RouteSuspense>
  ),
});

const askRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ask",
  beforeLoad: ({ context }) => ensureLoggedIn(context),
  component: () => (
    <RouteSuspense>
      <Ask />
    </RouteSuspense>
  ),
});

const findRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/find",
  beforeLoad: ({ context }) => ensureLoggedIn(context),
  component: () => (
    <RouteSuspense>
      <Find />
    </RouteSuspense>
  ),
});

type LibrarySearch = {
  tab?: "review" | "archive";
  document_type?: string;
  correspondent?: string;
  date_from?: string;
  date_to?: string;
  text?: string;
  tags?: string[];
  page?: number;
  ordering?: LibraryOrdering;
};

// Closed set mirroring the backend `_ALLOWED_ORDERING` allowlist in
// services/aktenraum-api/src/aktenraum_api/library/router.py. Validated
// in URL parsing so a typo never bypasses the backend's 422 check.
export type LibraryOrdering =
  | "-created"
  | "created"
  | "-modified"
  | "modified"
  | "title"
  | "-title";

const LIBRARY_ORDERINGS: readonly LibraryOrdering[] = [
  "-created",
  "created",
  "-modified",
  "modified",
  "title",
  "-title",
];

function isLibraryOrdering(value: unknown): value is LibraryOrdering {
  return typeof value === "string" && (LIBRARY_ORDERINGS as readonly string[]).includes(value);
}

const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library",
  beforeLoad: ({ context }) => ensureLoggedIn(context),
  // Coerce raw URL params (always strings) into the typed shape the page expects.
  validateSearch: (search: Record<string, unknown>): LibrarySearch => {
    const out: LibrarySearch = {};
    const tab = search["tab"];
    if (tab === "review" || tab === "archive") out.tab = tab;
    type ScalarKey = Exclude<keyof LibrarySearch, "tags" | "tab">;
    const str = (k: ScalarKey) =>
      typeof search[k] === "string" && search[k] !== ""
        ? (search[k] as string)
        : undefined;
    const num = (k: ScalarKey) => {
      const v = search[k];
      if (typeof v === "number") return v;
      if (typeof v === "string" && v !== "") {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      }
      return undefined;
    };
    // Tag URL state: a single ?tags=foo collapses to a string while
    // ?tags=foo&tags=bar arrives as string[]. Normalise both shapes to a
    // string[] without empties so downstream code sees one type.
    const tagsRaw = search["tags"];
    let tags: string[] | undefined;
    if (Array.isArray(tagsRaw)) {
      tags = tagsRaw.filter(
        (t): t is string => typeof t === "string" && t !== "",
      );
    } else if (typeof tagsRaw === "string" && tagsRaw !== "") {
      tags = [tagsRaw];
    }
    if (tags && tags.length > 0) out.tags = tags;
    out.document_type = str("document_type");
    out.correspondent = str("correspondent");
    out.date_from = str("date_from");
    out.date_to = str("date_to");
    out.text = str("text");
    out.page = num("page");
    // Ordering is a closed enum; unknown values silently fall back to
    // undefined (which downstream means "use the default").
    if (isLibraryOrdering(search["ordering"])) {
      out.ordering = search["ordering"];
    }
    return out;
  },
  component: function LibraryWrapper() {
    const search = libraryRoute.useSearch();
    return (
      <RouteSuspense>
        <Library search={search} />
      </RouteSuspense>
    );
  },
});

const libraryReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/$id",
  beforeLoad: ({ context }) => ensureLoggedIn(context),
  component: function LibraryReviewWrapper() {
    const { id } = libraryReviewRoute.useParams();
    return (
      <RouteSuspense>
        <LibraryReview id={Number(id)} />
      </RouteSuspense>
    );
  },
});

const trashRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/trash",
  beforeLoad: ({ context }) => ensureLoggedIn(context),
  component: () => (
    <RouteSuspense>
      <Trash />
    </RouteSuspense>
  ),
});

const uploadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/upload",
  beforeLoad: ({ context }) => ensureLoggedIn(context),
  component: () => (
    <RouteSuspense>
      <Upload />
    </RouteSuspense>
  ),
});

const scanRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/scan",
  beforeLoad: ({ context }) => ensureLoggedIn(context),
  component: () => (
    <RouteSuspense>
      <Scan />
    </RouteSuspense>
  ),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: ({ context }) => ensureLoggedIn(context),
  component: () => (
    <RouteSuspense>
      <SettingsPage />
    </RouteSuspense>
  ),
});

// Permanent redirect to the Library's review tab. The standalone /inbox
// page was retired when the review queue moved into the Library; the
// redirect stays so old bookmarks and external links keep working.
// No component is mounted — the redirect fires inside `beforeLoad`
// before the renderer runs.
const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  beforeLoad: async ({ context }) => {
    await ensureLoggedIn(context);
    throw redirect({ to: "/library", search: { tab: "review" } });
  },
});

const inboxReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox/$id",
  beforeLoad: ({ context }) => ensureLoggedIn(context),
  component: function InboxReviewWrapper() {
    const { id } = inboxReviewRoute.useParams();
    return (
      <RouteSuspense>
        <InboxReview id={Number(id)} />
      </RouteSuspense>
    );
  },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  askRoute,
  findRoute,
  libraryRoute,
  libraryReviewRoute,
  trashRoute,
  uploadRoute,
  scanRoute,
  settingsRoute,
  inboxRoute,
  inboxReviewRoute,
]);

export function buildRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, context: { queryClient } });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof buildRouter>;
  }
}
