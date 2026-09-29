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

export function useTagFacet() {
  const api = useApi();
  return useQuery({
    queryKey: ["library-tags"],
    queryFn: () => api.get<TagFacetList>("/library/tags"),
    staleTime: 5 * 60_000,
  });
}
