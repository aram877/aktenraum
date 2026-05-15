import { useMutation } from "@tanstack/react-query";
import type { AxiosError } from "axios";

import { api } from "./api";

export type DocumentType =
  | "Rechnung"
  | "Gehaltsabrechnung"
  | "Kontoauszug"
  | "Nebenkostenabrechnung"
  | "Hausgeldabrechnung"
  | "Mahnung"
  | "Vertrag"
  | "Kündigung"
  | "Versicherung"
  | "Steuer"
  | "Lohnsteuerbescheinigung"
  | "Spendenbescheinigung"
  | "Bescheid"
  | "Behördenbrief"
  | "Sozialversicherungsmeldung"
  | "Kfz"
  | "Bußgeldbescheid"
  | "Arztbrief"
  | "Krankschreibung"
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
  text?: string | null;
  tags?: string[];
};

export type DocumentSummary = {
  id: number;
  title: string;
  original_file_name: string | null;
  correspondent: string | null;
  document_type: string | null;
  created: string | null;
  lifecycle_tags: string[];
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

// ---- Ask streaming (SSE) ----

export type StreamMeta = {
  filter: SearchFilter;
  explanation: string;
  total: number;
};

export type StreamFinal = {
  answer_de: string;
  citations: DocumentSummary[];
  total: number;
};

export type StreamHandlers = {
  onMeta?: (meta: StreamMeta) => void;
  onChunk?: (delta: string) => void;
  onFinal?: (final: StreamFinal) => void;
  onError?: (detail: string) => void;
};

/**
 * Stream an answer from `/api/ai/answer/stream`. The endpoint emits
 * Server-Sent Events: `meta` once, `chunk` zero-or-more times, then either
 * `final` or `error`. We use fetch + ReadableStream rather than EventSource
 * because the endpoint is POST (the question lives in the body) and
 * EventSource is GET-only.
 *
 * Returns an `AbortController` so the caller can cancel mid-stream (e.g.
 * the user navigates away). Cancelling closes the upstream and stops billing
 * tokens on the server.
 */
export function streamAsk(
  question: string,
  handlers: StreamHandlers,
): AbortController {
  const controller = new AbortController();
  void (async () => {
    try {
      const resp = await fetch("/api/ai/answer/stream", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        const detail = `${resp.status} ${resp.statusText}`;
        handlers.onError?.(detail);
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      // SSE records are separated by a blank line. Buffer across reads since
      // a single chunk may contain a partial record.
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n\n");
        while (idx !== -1) {
          const record = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          dispatchSseRecord(record, handlers);
          idx = buffer.indexOf("\n\n");
        }
      }
      // Flush any trailing record without a terminating blank line.
      if (buffer.trim().length > 0) {
        dispatchSseRecord(buffer, handlers);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      const detail = err instanceof Error ? err.message : String(err);
      handlers.onError?.(detail);
    }
  })();
  return controller;
}

function dispatchSseRecord(record: string, h: StreamHandlers) {
  let event = "message";
  let data = "";
  for (const line of record.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      // SSE allows multi-line data: lines, joined by \n. Our server emits
      // one-line JSON, so we just append.
      data += (data ? "\n" : "") + line.slice(5).trim();
    }
  }
  if (!data) return;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return;
  }
  switch (event) {
    case "meta":
      h.onMeta?.(payload as StreamMeta);
      break;
    case "chunk":
      h.onChunk?.((payload as { text: string }).text);
      break;
    case "final":
      h.onFinal?.(payload as StreamFinal);
      break;
    case "error":
      h.onError?.((payload as { detail: string }).detail);
      break;
  }
}
