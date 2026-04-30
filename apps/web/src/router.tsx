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
  document_type?: string;
  correspondent?: string;
  date_from?: string;
  date_to?: string;
  min_amount?: number;
  max_amount?: number;
  text?: string;
  page?: number;
};

const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library",
  beforeLoad: ({ context }) => ensureLoggedIn(context),
  // Coerce raw URL params (always strings) into the typed shape the page expects.
  validateSearch: (search: Record<string, unknown>): LibrarySearch => {
    const out: LibrarySearch = {};
    const str = (k: keyof LibrarySearch) =>
      typeof search[k] === "string" && search[k] !== ""
        ? (search[k] as string)
        : undefined;
    const num = (k: keyof LibrarySearch) => {
      const v = search[k];
      if (typeof v === "number") return v;
      if (typeof v === "string" && v !== "") {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      }
      return undefined;
    };
    out.document_type = str("document_type");
    out.correspondent = str("correspondent");
    out.date_from = str("date_from");
    out.date_to = str("date_to");
    out.text = str("text");
    out.min_amount = num("min_amount");
    out.max_amount = num("max_amount");
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

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  beforeLoad: ({ context }) => ensureLoggedIn(context),
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
