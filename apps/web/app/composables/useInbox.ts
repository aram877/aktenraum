import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import type { MaybeRefOrGetter } from "vue";

export interface BulkApproveResult {
  succeeded: number[];
  failed: { id: number; message: string }[];
}

export const INBOX_KEY = ["inbox"] as const;

export const BULK_APPROVE_CONCURRENCY = 4;

function inboxApi(api: ApiClient) {
  return {
    list(params: { page?: number; pageSize?: number; ordering?: string } = {}): Promise<InboxList> {
      const search = new URLSearchParams();
      search.set("page", String(params.page ?? 1));
      search.set("page_size", String(params.pageSize ?? 20));
      search.set("ordering", params.ordering ?? "-modified");
      return api.get<InboxList>(`/inbox/?${search.toString()}`);
    },
    detail: (id: number) => api.get<InboxDetail>(`/inbox/${id}`),
    approve: (id: number, body?: InboxFieldUpdate) => api.post(`/inbox/${id}/approve`, body ?? {}),
    reject: (id: number) => api.post(`/inbox/${id}/reject`, {}),
  };
}

export function useInboxDetail(id: MaybeRefOrGetter<number | null>) {
  const api = inboxApi(useApi());
  return useQuery(() => ({
    queryKey: [...INBOX_KEY, "detail", toValue(id)],
    queryFn: () => api.detail(toValue(id) as number),
    enabled: toValue(id) !== null,
    staleTime: 30_000,
  }));
}

export function useInboxList(
  params: { pageSize?: number } = {},
  enabled: MaybeRefOrGetter<boolean> = true,
) {
  const api = inboxApi(useApi());
  const pageSize = params.pageSize ?? 50;
  return useQuery(() => ({
    queryKey: [...INBOX_KEY, "list", 1, pageSize, "-modified"],
    queryFn: () => api.list({ page: 1, pageSize, ordering: "-modified" }),
    enabled: toValue(enabled),
    staleTime: 30_000,
  }));
}

export function useApprove(id: MaybeRefOrGetter<number | null>) {
  const api = inboxApi(useApi());
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body?: InboxFieldUpdate) => api.approve(toValue(id) as number, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INBOX_KEY });
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
}

export function useReject(id: MaybeRefOrGetter<number | null>) {
  const api = inboxApi(useApi());
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.reject(toValue(id) as number),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INBOX_KEY });
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
}

export function useInboxListInfinite(params: { pageSize?: number; ordering?: string } = {}) {
  const api = inboxApi(useApi());
  const pageSize = params.pageSize ?? 50;
  const ordering = params.ordering ?? "-modified";
  return useInfiniteQuery({
    queryKey: [...INBOX_KEY, "list-infinite", pageSize, ordering],
    queryFn: ({ pageParam }: { pageParam: number }) => api.list({ page: pageParam, pageSize, ordering }),
    initialPageParam: 1,
    getNextPageParam: nextPageParam,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useBulkApprove() {
  const api = inboxApi(useApi());
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: number[]): Promise<BulkApproveResult> => {
      const results = await runWithConcurrency(ids, BULK_APPROVE_CONCURRENCY, async (id) => {
        try {
          await api.approve(id);
          return { id, ok: true as const };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Fehler";
          return { id, ok: false as const, message };
        }
      });
      const succeeded: number[] = [];
      const failed: { id: number; message: string }[] = [];
      for (const r of results) {
        if (r.ok) succeeded.push(r.id);
        else failed.push({ id: r.id, message: r.message });
      }
      return { succeeded, failed };
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: INBOX_KEY });
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
}
