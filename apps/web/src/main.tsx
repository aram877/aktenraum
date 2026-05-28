import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import { buildRouter } from "./router";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Library defaults to 3 retries with backoff; that turns a hard 500
      // into a ~7s hang and pointlessly retries auth failures. Retry once,
      // and never retry 401/403 — surfacing the login redirect fast beats
      // three round-trips that will fail the same way.
      retry: (failureCount, error) => {
        const status = (
          error as { response?: { status?: number } } | undefined
        )?.response?.status;
        if (status === 401 || status === 403) return false;
        return failureCount < 1;
      },
    },
  },
});
const router = buildRouter(queryClient);

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("#root element missing from index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
