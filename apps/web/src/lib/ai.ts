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

export type FindResponse = {
  filter: SearchFilter;
  results: DocumentSummary[];
  explanation: string;
  total: number;
};

export type AnswerResponse = {
  question: string;
  answer_de: string;
  citations: DocumentSummary[];
  filter: SearchFilter;
  total: number;
};

// ---- Find ----

export async function findByQuery(query: string): Promise<FindResponse> {
  const { data } = await api.post<FindResponse>("/ai/find", { query });
  return data;
}

export async function findByFilter(filter: SearchFilter): Promise<FindResponse> {
  const { data } = await api.post<FindResponse>("/ai/find", { filter });
  return data;
}

export type FindInput = { query: string } | { filter: SearchFilter };

export function useFind() {
  return useMutation<FindResponse, AxiosError<{ detail?: string }>, FindInput>({
    mutationFn: async (input) =>
      "query" in input ? findByQuery(input.query) : findByFilter(input.filter),
  });
}

// ---- Ask (conversational answer) ----

export async function ask(question: string): Promise<AnswerResponse> {
  const { data } = await api.post<AnswerResponse>("/ai/answer", { question });
  return data;
}

export function useAsk() {
  return useMutation<AnswerResponse, AxiosError<{ detail?: string }>, string>({
    mutationFn: ask,
  });
}
