import { inject, Injectable } from "@angular/core";
import { injectQuery } from "@tanstack/angular-query-experimental";

import { ApiClient } from "./api";

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

export function toQueryString(query: LibraryQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === "" || item === null || item === undefined) continue;
        params.append(key, String(item));
      }
      continue;
    }
    params.append(key, String(value));
  }
  return params.toString();
}

export const DOC_TYPES = [
  "Rechnung",
  "Gehaltsabrechnung",
  "Kontoauszug",
  "Nebenkostenabrechnung",
  "Hausgeldabrechnung",
  "Mahnung",
  "Vertrag",
  "Kündigung",
  "Versicherung",
  "Steuer",
  "Lohnsteuerbescheinigung",
  "Spendenbescheinigung",
  "Bescheid",
  "Behördenbrief",
  "Sozialversicherungsmeldung",
  "Kfz",
  "Bußgeldbescheid",
  "Arztbrief",
  "Krankschreibung",
  "Garantie",
  "Urkunde",
  "Ausweis",
  "Zeugnis",
  "Arbeitszeugnis",
  "Mitgliedschaft",
  "Beleg",
  "Sonstiges",
] as const;

export const ORDERING_OPTIONS = [
  { value: "-created", label: "Dokumentdatum (neueste zuerst)" },
  { value: "created", label: "Dokumentdatum (älteste zuerst)" },
  { value: "-modified", label: "Zuletzt geändert (neueste zuerst)" },
  { value: "modified", label: "Zuletzt geändert (älteste zuerst)" },
  { value: "title", label: "Titel (A–Z)" },
  { value: "-title", label: "Titel (Z–A)" },
] as const;

@Injectable({ providedIn: "root" })
export class LibraryApi {
  private readonly api = inject(ApiClient);

  list(query: LibraryQuery): Promise<LibraryList> {
    const qs = toQueryString(query);
    return this.api.get<LibraryList>(qs ? `/library/?${qs}` : "/library/");
  }

  tagFacet(): Promise<TagFacetList> {
    return this.api.get<TagFacetList>("/library/tags");
  }
}

export function injectLibrary(query: () => LibraryQuery) {
  const api = inject(LibraryApi);
  return injectQuery(() => ({
    queryKey: ["library", query()],
    queryFn: () => api.list(query()),
    staleTime: 15_000,
  }));
}

export function injectTagFacet() {
  const api = inject(LibraryApi);
  return injectQuery(() => ({
    queryKey: ["library-tags"],
    queryFn: () => api.tagFacet(),
    staleTime: 5 * 60_000,
  }));
}
