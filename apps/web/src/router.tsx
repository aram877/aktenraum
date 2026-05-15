import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { Ask } from "./routes/Ask";
import { Find } from "./routes/Find";
import { Home } from "./routes/Home";
import { Inbox } from "./routes/Inbox";
import { InboxReview } from "./routes/InboxReview";
import { Library } from "./routes/Library";
import { LibraryReview } from "./routes/LibraryReview";
import { Login } from "./routes/Login";
import { SettingsPage } from "./routes/Settings";
import { Upload } from "./routes/Upload";
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
  component: Home,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: Login,
});

const askRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ask",
  beforeLoad: ({ context }) => ensureLoggedIn(context),
  component: Ask,
});

const findRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/find",
  beforeLoad: ({ context }) => ensureLoggedIn(context),
  component: Find,
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
};

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
    return out;
  },
  component: function LibraryWrapper() {
    const search = libraryRoute.useSearch();
    return <Library search={search} />;
  },
});

const libraryReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/$id",
  beforeLoad: ({ context }) => ensureLoggedIn(context),
  component: function LibraryReviewWrapper() {
    const { id } = libraryReviewRoute.useParams();
    return <LibraryReview id={Number(id)} />;
  },
});

const uploadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/upload",
  beforeLoad: ({ context }) => ensureLoggedIn(context),
  component: Upload,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: ({ context }) => ensureLoggedIn(context),
  component: SettingsPage,
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  beforeLoad: async ({ context }) => {
    await ensureLoggedIn(context);
    throw redirect({ to: "/library", search: { tab: "review" } });
  },
  component: Inbox,
});

const inboxReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox/$id",
  beforeLoad: ({ context }) => ensureLoggedIn(context),
  component: function InboxReviewWrapper() {
    const { id } = inboxReviewRoute.useParams();
    return <InboxReview id={Number(id)} />;
  },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  askRoute,
  findRoute,
  libraryRoute,
  libraryReviewRoute,
  uploadRoute,
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
