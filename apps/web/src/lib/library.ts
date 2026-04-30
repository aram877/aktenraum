import { useQuery } from "@tanstack/react-query";
import type { AxiosError } from "axios";

import { api } from "./api";

export type LibraryItem = {
  id: number;
  title: string;
  created: string | null;
  correspondent: string | null;
  document_type: string | null;
  monetary_amount: string | null;
  lifecycle_tags: string[];
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
  page?: number | null;
  page_size?: number | null;
  ordering?: string | null;
};

function toParams(q: LibraryQuery): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v === null || v === undefined || v === "") continue;
    out[k] = v as string | number;
  }
  return out;
}

async function fetchLibrary(q: LibraryQuery): Promise<LibraryList> {
  const { data } = await api.get<LibraryList>("/library/", {
    params: toParams(q),
  });
  return data;
}

export function useLibrary(q: LibraryQuery) {
  return useQuery<LibraryList, AxiosError<{ detail?: string }>>({
    queryKey: ["library", q],
    queryFn: () => fetchLibrary(q),
    staleTime: 15_000,
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
