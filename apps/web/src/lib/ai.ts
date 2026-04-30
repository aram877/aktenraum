import { useMutation } from "@tanstack/react-query";
import type { AxiosError } from "axios";

import { api } from "./api";

export type DocumentType =
  | "Rechnung"
  | "Gehaltsabrechnung"
  | "Kontoauszug"
  | "Nebenkostenabrechnung"
  | "Mahnung"
  | "Vertrag"
  | "Kündigung"
  | "Versicherung"
  | "Steuer"
  | "Bescheid"
  | "Behördenbrief"
  | "Kfz"
  | "Arztbrief"
  | "Garantie"
  | "Urkunde"
  | "Ausweis"
  | "Zeugnis"
  | "Arbeitszeugnis"
  | "Mitgliedschaft"
  | "Sonstiges";

export type SearchFilter = {
  document_type?: DocumentType | null;
  correspondent?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  min_amount?: number | null;
  max_amount?: number | null;
  text?: string | null;
};

export type DocumentSummary = {
  id: number;
  title: string;
  correspondent: string | null;
  document_type: string | null;
  created: string | null;
  monetary_amount: string | null;
};

export type AskResponse = {
  filter: SearchFilter;
  results: DocumentSummary[];
  explanation: string;
  total: number;
};

export async function ask(query: string): Promise<AskResponse> {
  const { data } = await api.post<AskResponse>("/ai/ask", { query });
  return data;
}

export async function searchByFilter(filter: SearchFilter): Promise<AskResponse> {
  const { data } = await api.post<AskResponse>("/ai/ask", { filter });
  return data;
}

export type AskInput = { query: string } | { filter: SearchFilter };

export function useAsk() {
  return useMutation<AskResponse, AxiosError<{ detail?: string }>, AskInput>({
    mutationFn: async (input) => {
      if ("query" in input) return ask(input.query);
      return searchByFilter(input.filter);
    },
  });
}
