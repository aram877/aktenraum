import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { Ask } from "./routes/Ask";
import { Home } from "./routes/Home";
import { Login } from "./routes/Login";
import { fetchMe } from "./lib/api";
import type { QueryClient } from "@tanstack/react-query";

interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  // Run the auth check before the route renders. If unauthenticated, redirect
  // to /login. The query result is cached so the home page reads it without a
  // second request.
  beforeLoad: async ({ context }) => {
    try {
      await context.queryClient.fetchQuery({
        queryKey: ["me"],
        queryFn: fetchMe,
      });
    } catch {
      throw redirect({ to: "/login" });
    }
  },
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
  beforeLoad: async ({ context }) => {
    try {
      await context.queryClient.fetchQuery({
        queryKey: ["me"],
        queryFn: fetchMe,
      });
    } catch {
      throw redirect({ to: "/login" });
    }
  },
  component: Ask,
});

const routeTree = rootRoute.addChildren([indexRoute, loginRoute, askRoute]);

export function buildRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, context: { queryClient } });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof buildRouter>;
  }
}
