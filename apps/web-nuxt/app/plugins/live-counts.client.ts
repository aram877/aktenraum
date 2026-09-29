import { QueryObserver } from "@tanstack/vue-query";

export default defineNuxtPlugin({
  name: "live-counts",
  dependsOn: ["vue-query"],
  setup(nuxtApp) {
    const queryClient = nuxtApp.$queryClient;
    const stream = createLiveCountsStream(queryClient);
    const me = new QueryObserver(queryClient, { queryKey: ME_KEY, enabled: false });
    me.subscribe((result) => {
      if (result.data) stream.start();
      else stream.stop();
    });
  },
});
