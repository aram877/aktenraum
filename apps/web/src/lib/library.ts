import { useQuery } from "@tanstack/react-query";
import type { AxiosError } from "axios";

import { api } from "./api";

export type LibraryItem = {
  id: number;
  title: string;
  original_file_name: string | null;
  created: string | null;
  correspondent: string | null;
  document_type: string | null;
  monetary_amount: string | null;
  lifecycle_tags: string[];
  tags: string[];
};

export type LibraryList = {
  results: LibraryItem[];
  total: number;
  page: number;
  page_size: number;
};

export type LibraryQuery = {
  document_type?: string | null;
  correspondent?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  min_amount?: number | null;
  max_amount?: number | null;
  text?: string | null;
  tags?: string[] | null;
  page?: number | null;
  page_size?: number | null;
  ordering?: string | null;
};

export type TagFacet = { name: string; count: number };
export type TagFacetList = { results: TagFacet[] };

// FastAPI's `tags: list[str] = Query(None)` reads repeated keys without
// brackets (e.g. ?tags=a&tags=b). Axios's default array serialisation across
// versions has been inconsistent (sometimes `tags[]=a`), so we serialise to
// URLSearchParams ourselves and hand axios the finished string. That way the
// wire format is stable regardless of axios upgrades.
function toQueryString(q: LibraryQuery): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item === "" || item === null || item === undefined) continue;
        params.append(k, String(item));
      }
      continue;
    }
    params.append(k, String(v));
  }
  return params.toString();
}

async function fetchLibrary(q: LibraryQuery): Promise<LibraryList> {
  const qs = toQueryString(q);
  const { data } = await api.get<LibraryList>(
    qs ? `/library/?${qs}` : "/library/",
  );
  return data;
}

export function useLibrary(q: LibraryQuery) {
  return useQuery<LibraryList, AxiosError<{ detail?: string }>>({
    queryKey: ["library", q],
    queryFn: () => fetchLibrary(q),
    staleTime: 15_000,
  });
}

async function fetchTagFacet(): Promise<TagFacetList> {
  const { data } = await api.get<TagFacetList>("/library/tags");
  return data;
}

export function useTagFacet() {
  return useQuery<TagFacetList, AxiosError<{ detail?: string }>>({
    queryKey: ["library-tags"],
    queryFn: fetchTagFacet,
    // Tags don't change every keystroke; one fetch per session is plenty.
    staleTime: 5 * 60_000,
  });
}

// The 20 doc types live closed-enum on the server; mirroring them in the SPA
// keeps the select static (no extra fetch). Order matches DocumentType.
export const DOC_TYPES = [
  "Rechnung",
  "Gehaltsabrechnung",
  "Kontoauszug",
  "Nebenkostenabrechnung",
  "Mahnung",
  "Vertrag",
  "Kündigung",
  "Versicherung",
  "Steuer",
  "Bescheid",
  "Behördenbrief",
  "Kfz",
  "Arztbrief",
  "Garantie",
  "Urkunde",
  "Ausweis",
  "Zeugnis",
  "Arbeitszeugnis",
  "Mitgliedschaft",
  "Sonstiges",
] as const;
