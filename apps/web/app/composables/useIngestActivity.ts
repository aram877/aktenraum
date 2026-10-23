import { useQuery } from "@tanstack/vue-query";
import type { MaybeRefOrGetter } from "vue";

export const INGEST_KEY = ["ingest", "activity"] as const;

export const INGEST_POLL_MS = 5_000;

export function useIngestActivity(days: MaybeRefOrGetter<number>) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: [...INGEST_KEY, { days: toValue(days) }],
    queryFn: () => api.get<IngestActivity>(`/ingest/activity?days=${toValue(days)}`),
    staleTime: 10_000,
    refetchInterval: (query: { state: { data: IngestActivity | undefined } }) =>
      activitySettled(query.state.data) ? false : INGEST_POLL_MS,
  }));
}
