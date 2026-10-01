import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import type { MaybeRefOrGetter } from "vue";

export interface ReprocessResponse {
  doc_id: number;
  cleared_tags: string[];
  auto_tagger_notified: boolean;
}

export interface InFlightCount {
  count: number;
}

export const DOCUMENT_DETAIL_KEY = "document-detail";

export function useDocumentDetail(id: MaybeRefOrGetter<number | null>) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: [DOCUMENT_DETAIL_KEY, toValue(id)],
    queryFn: () => api.get<InboxDetail>(`/documents/${toValue(id)}/detail`),
    enabled: toValue(id) !== null,
    staleTime: 30_000,
  }));
}

export function useDocumentFieldsPatch(id: MaybeRefOrGetter<number | null>) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: InboxFieldUpdate) =>
      api.patch<InboxDetail>(`/documents/${toValue(id)}/fields`, body),
    onSuccess: (data) => {
      queryClient.setQueryData([DOCUMENT_DETAIL_KEY, toValue(id)], data);
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
}

export function useReprocess() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<ReprocessResponse>(`/documents/${id}/reprocess`, {}),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ["library"] });
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
      void queryClient.invalidateQueries({ queryKey: [DOCUMENT_DETAIL_KEY, id] });
    },
  });
}

export function useInFlightCount(enabled: MaybeRefOrGetter<boolean> = true) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: ["in-flight"],
    queryFn: () => api.get<InFlightCount>("/documents/in-flight"),
    enabled: toValue(enabled),
    refetchInterval: 30_000,
    staleTime: 15_000,
  }));
}
