import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/vue-query";
import type { MaybeRefOrGetter } from "vue";

export interface TrashItem {
  id: number;
  title: string;
  original_file_name: string | null;
  created: string | null;
  deleted_at: string | null;
  correspondent: string | null;
  document_type: string | null;
  ai_correspondent: string | null;
  ai_document_type: string | null;
  ai_summary_de: string | null;
}

export interface TrashList {
  results: TrashItem[];
  total: number;
  page: number;
  page_size: number;
}

export const TRASH_KEY = ["trash"] as const;

export function useTrashList(enabled: MaybeRefOrGetter<boolean> = true) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: [...TRASH_KEY, "list"],
    queryFn: () => api.get<TrashList>("/trash/?page=1&page_size=20"),
    enabled: toValue(enabled),
    staleTime: 15_000,
  }));
}

function invalidateTrashAndLibrary(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: TRASH_KEY });
  void queryClient.invalidateQueries({ queryKey: ["library"] });
}

export function useRestore() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<unknown>(`/trash/${id}/restore`, {}),
    onSuccess: () => invalidateTrashAndLibrary(queryClient),
  });
}

export function useDeleteForever() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<unknown>(`/trash/${id}/delete`, {}),
    onSuccess: () => invalidateTrashAndLibrary(queryClient),
  });
}

export function useEmptyTrash() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ emptied: number }>("/trash/empty", {}),
    onSuccess: () => invalidateTrashAndLibrary(queryClient),
  });
}
