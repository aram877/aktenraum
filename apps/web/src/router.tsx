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
import { Login } from "./routes/Login";
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
