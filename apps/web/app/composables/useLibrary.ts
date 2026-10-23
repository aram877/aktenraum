import { useQuery } from "@tanstack/vue-query";
import type { MaybeRefOrGetter } from "vue";

export interface LibraryItem {
  id: number;
  title: string;
  original_file_name: string | null;
  created: string | null;
  added: string | null;
  correspondent: string | null;
  document_type: string | null;
  lifecycle_tags: string[];
  tags: string[];
  ai_error_message: string | null;
  is_processing: boolean;
}

export interface LibraryList {
  results: LibraryItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface LibraryQuery {
  document_type?: string | null;
  correspondent?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  text?: string | null;
  tags?: string[] | null;
  status?: string | null;
  page?: number | null;
  page_size?: number | null;
  ordering?: string | null;
}

export interface TagFacet {
  name: string;
  count: number;
}

export interface TagFacetList {
  results: TagFacet[];
}

export function useLibrary(query: MaybeRefOrGetter<LibraryQuery>) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: ["library", toValue(query)],
    queryFn: () => {
      const qs = toQueryString({ ...toValue(query) });
      return api.get<LibraryList>(qs ? `/library/?${qs}` : "/library/");
    },
    staleTime: 15_000,
  }));
}

/**
 * Poll fallback for the nav error badge when the live stream has not pushed
 * yet. Keyed under "library" so any library invalidation refreshes it.
 */
export function useErrorCount(enabled: MaybeRefOrGetter<boolean> = true) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: ["library", "error-count"],
    queryFn: () => api.get<LibraryList>("/library/?status=error&page_size=1"),
    enabled: toValue(enabled),
    refetchInterval: 30_000,
    staleTime: 15_000,
  }));
}

/** Every document has exactly one type, unlike the AI's free-form tags. */
export function useTypeFacet() {
  const api = useApi();
  return useQuery({
    queryKey: ["library-types"],
    queryFn: () => api.get<TagFacetList>("/library/types"),
    staleTime: 60_000,
  });
}

export function useTagFacet() {
  const api = useApi();
  return useQuery({
    queryKey: ["library-tags"],
    queryFn: () => api.get<TagFacetList>("/library/tags"),
    staleTime: 5 * 60_000,
  });
}
