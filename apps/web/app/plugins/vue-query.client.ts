import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";

export default defineNuxtPlugin({
  name: "vue-query",
  setup(nuxtApp) {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 30_000,
          retry: 1,
          refetchOnWindowFocus: false,
        },
      },
    });
    nuxtApp.vueApp.use(VueQueryPlugin, { queryClient });
    return { provide: { queryClient } };
  },
});
