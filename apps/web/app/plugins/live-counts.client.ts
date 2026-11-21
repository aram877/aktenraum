import { QueryObserver } from "@tanstack/vue-query";

export default defineNuxtPlugin({
  name: "live-counts",
  dependsOn: ["vue-query"],
  setup(nuxtApp) {
    const queryClient = nuxtApp.$queryClient;
    const stream = createLiveCountsStream(queryClient);
    const me = new QueryObserver<User | null>(queryClient, { queryKey: ME_KEY, enabled: false });
    me.subscribe((result) => {
      // A restricted session (enrolment pending) can't open the stream (403).
      if (result.data && !result.data.enrolment_required) stream.start();
      else stream.stop();
    });
  },
});
