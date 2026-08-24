import { ApplicationConfig, provideBrowserGlobalErrorListeners } from "@angular/core";
import { provideHttpClient, withFetch } from "@angular/common/http";
import { provideRouter } from "@angular/router";
import { QueryClient, provideTanStackQuery } from "@tanstack/angular-query-experimental";

import { routes } from "./app.routes";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withFetch()),
    provideTanStackQuery(queryClient),
  ],
};
