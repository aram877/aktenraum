import { inject, Injectable } from "@angular/core";
import {
  injectMutation,
  injectQuery,
  QueryClient,
} from "@tanstack/angular-query-experimental";

import { ApiClient } from "./api";
import type { InboxDetail, InboxFieldUpdate } from "./inbox";

export interface ReprocessResponse {
  doc_id: number;
  cleared_tags: string[];
  auto_tagger_notified: boolean;
}

export interface InFlightCount {
  count: number;
}

export const DOCUMENT_DETAIL_KEY = "document-detail";

@Injectable({ providedIn: "root" })
export class DocumentsApi {
  private readonly api = inject(ApiClient);

  detail(id: number): Promise<InboxDetail> {
    return this.api.get<InboxDetail>(`/documents/${id}/detail`);
  }

  patchFields(id: number, body: InboxFieldUpdate): Promise<InboxDetail> {
    return this.api.patch<InboxDetail>(`/documents/${id}/fields`, body);
  }

  reprocess(id: number): Promise<ReprocessResponse> {
    return this.api.post<ReprocessResponse>(`/documents/${id}/reprocess`, {});
  }

  star(id: number): Promise<unknown> {
    return this.api.post(`/documents/${id}/star`, {});
  }

  inFlight(): Promise<InFlightCount> {
    return this.api.get<InFlightCount>("/documents/in-flight");
  }
}

export function injectDocumentDetail(id: () => number | null) {
  const api = inject(DocumentsApi);
  return injectQuery(() => ({
    queryKey: [DOCUMENT_DETAIL_KEY, id()],
    queryFn: () => api.detail(id() as number),
    enabled: id() !== null,
    staleTime: 30_000,
  }));
}

export function injectDocumentFieldsPatch(id: () => number) {
  const api = inject(DocumentsApi);
  const queryClient = inject(QueryClient);
  return injectMutation(() => ({
    mutationFn: (body: InboxFieldUpdate) => api.patchFields(id(), body),
    onSuccess: (data: InboxDetail) => {
      queryClient.setQueryData([DOCUMENT_DETAIL_KEY, id()], data);
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  }));
}

export function injectReprocess() {
  const api = inject(DocumentsApi);
  const queryClient = inject(QueryClient);
  return injectMutation(() => ({
    mutationFn: (id: number) => api.reprocess(id),
    onSuccess: (_data: ReprocessResponse, id: number) => {
      void queryClient.invalidateQueries({ queryKey: ["library"] });
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
      void queryClient.invalidateQueries({ queryKey: [DOCUMENT_DETAIL_KEY, id] });
    },
  }));
}

export function injectInFlightCount(enabled: () => boolean = () => true) {
  const api = inject(DocumentsApi);
  return injectQuery(() => ({
    queryKey: ["in-flight"],
    queryFn: () => api.inFlight(),
    enabled: enabled(),
    refetchInterval: 30_000,
    staleTime: 15_000,
  }));
}
