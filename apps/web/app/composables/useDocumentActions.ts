import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/vue-query";
import type { MaybeRefOrGetter } from "vue";

export interface TypeFieldDef {
  name: string;
  label_de: string;
  field_type: "string" | "money" | "date" | "month" | "year";
}

export type TypeFieldSchema = Record<string, TypeFieldDef[]>;

export interface TypeFieldsResponse {
  document_type: string;
  fields: Record<string, string>;
}

export interface DuplicateCandidates {
  doc_id: number;
  candidates: DocumentSummary[];
}

export const TYPE_FIELD_SCHEMA_KEY = ["document-types", "schema"] as const;
export const DUPLICATES_KEY = "duplicate-candidates";

function invalidateDocument(queryClient: QueryClient, id: number | null): void {
  void queryClient.invalidateQueries({ queryKey: [DOCUMENT_DETAIL_KEY, id] });
  void queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, "detail", id] });
  void queryClient.invalidateQueries({ queryKey: ["library"] });
}

export function useToggleStar(id: MaybeRefOrGetter<number | null>) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (starred: boolean) => {
      const path = `/documents/${toValue(id)}/star`;
      return starred ? api.post(path, {}) : api.del(path);
    },
    onSuccess: () => {
      invalidateDocument(queryClient, toValue(id));
      void queryClient.invalidateQueries({ queryKey: ["library-tags"] });
    },
  });
}

export function useDeleteDocument() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/documents/${id}`),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: [DOCUMENT_DETAIL_KEY, id] });
      void queryClient.invalidateQueries({ queryKey: ["library"] });
      void queryClient.invalidateQueries({ queryKey: INBOX_KEY });
      void queryClient.invalidateQueries({ queryKey: TRASH_KEY });
      void queryClient.invalidateQueries({ queryKey: ["in-flight"] });
    },
  });
}

export function useDuplicateCandidates(
  id: MaybeRefOrGetter<number | null>,
  enabled: MaybeRefOrGetter<boolean>,
) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: [DUPLICATES_KEY, toValue(id)],
    queryFn: () => api.get<DuplicateCandidates>(`/documents/${toValue(id)}/duplicate-candidates`),
    enabled: toValue(id) !== null && toValue(enabled),
    staleTime: 30_000,
  }));
}

export function useDismissDuplicate(id: MaybeRefOrGetter<number | null>) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`/documents/${toValue(id)}/dismiss-duplicate`, {}),
    onSuccess: () => {
      invalidateDocument(queryClient, toValue(id));
      void queryClient.invalidateQueries({ queryKey: [DUPLICATES_KEY, toValue(id)] });
    },
  });
}

export function useTypeFieldSchema() {
  const api = useApi();
  return useQuery({
    queryKey: TYPE_FIELD_SCHEMA_KEY,
    queryFn: () => api.get<TypeFieldSchema>("/document-types/schema"),
    staleTime: 5 * 60_000,
  });
}

export function useTypeFieldsPatch(id: MaybeRefOrGetter<number | null>) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { document_type: string; fields: Record<string, string | null> }) =>
      api.patch<TypeFieldsResponse>(`/documents/${toValue(id)}/type-fields`, body),
    onSuccess: () => invalidateDocument(queryClient, toValue(id)),
  });
}
