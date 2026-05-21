import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AxiosError, AxiosProgressEvent } from "axios";

import { api } from "./api";

export type UploadResult = {
  filename: string;
  status: "accepted" | "error";
  task_id: string | null;
  detail: string | null;
};

export type UploadResponse = {
  results: UploadResult[];
};

export type ReprocessResponse = {
  doc_id: number;
  cleared_tags: string[];
  auto_tagger_notified: boolean;
};

type UploadArgs = {
  file: File;
  onProgress?: (pct: number) => void;
  title?: string;
};

export async function uploadDocument({
  file,
  onProgress,
  title,
}: UploadArgs): Promise<UploadResponse> {
  const fd = new FormData();
  fd.append("files", file, file.name);
  if (title) fd.append("title", title);
  const { data } = await api.post<UploadResponse>("/documents/upload", fd, {
    headers: { "Content-Type": "multipart/form-data" },
    onUploadProgress: (e: AxiosProgressEvent) => {
      if (onProgress && e.total) {
        onProgress(Math.round((e.loaded * 100) / e.total));
      }
    },
  });
  return data;
}

async function reprocessDocument(docId: number): Promise<ReprocessResponse> {
  const { data } = await api.post<ReprocessResponse>(
    `/documents/${docId}/reprocess`,
  );
  return data;
}

export function useReprocess() {
  const qc = useQueryClient();
  return useMutation<ReprocessResponse, AxiosError<{ detail?: string }>, number>({
    mutationFn: reprocessDocument,
    onSuccess: (_data, docId) => {
      // Reprocess clears the doc's lifecycle tags so the auto-tagger picks
      // it back up. Invalidate the lists + in-flight badge so the SPA sees
      // the new state on next visit, and refetch this doc's detail so the
      // ProcessingBadge on the page the user is sitting on updates from
      // "Verarbeitet" → "Wartet auf KI" without a hard reload.
      qc.invalidateQueries({ queryKey: ["library"] });
      qc.invalidateQueries({ queryKey: ["inbox"] });
      qc.invalidateQueries({ queryKey: ["in-flight"] });
      qc.invalidateQueries({ queryKey: ["document-detail", docId] });
    },
  });
}

export type BulkReprocessResult = {
  succeeded: number[];
  failed: { id: number; message: string }[];
};

export function useBulkReprocess() {
  const qc = useQueryClient();
  return useMutation<BulkReprocessResult, AxiosError, number[]>({
    // Same shape as useBulkApprove (inbox.ts): fire the per-id endpoint
    // in parallel, collect per-doc verdicts, leave query invalidation to
    // onSettled so the lists snap to the new state once all the responses
    // are in. /reprocess is fire-and-forget (clear lifecycle tags + ping
    // the auto-tagger webhook), so parallel calls have no contention.
    mutationFn: async (ids) => {
      const tasks = ids.map(async (id) => {
        try {
          await reprocessDocument(id);
          return { id, ok: true as const };
        } catch (err) {
          const message = (err as AxiosError | Error)?.message ?? "Fehler";
          return { id, ok: false as const, message };
        }
      });
      const results = await Promise.all(tasks);
      const succeeded: number[] = [];
      const failed: { id: number; message: string }[] = [];
      for (const r of results) {
        if (r.ok) succeeded.push(r.id);
        else failed.push({ id: r.id, message: r.message });
      }
      return { succeeded, failed };
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["library"] });
      qc.invalidateQueries({ queryKey: ["inbox"] });
      qc.invalidateQueries({ queryKey: ["in-flight"] });
    },
  });
}

async function dismissDuplicateRequest(docId: number): Promise<{ doc_id: number }> {
  const { data } = await api.post<{ doc_id: number }>(
    `/documents/${docId}/dismiss-duplicate`,
  );
  return data;
}

export function useDismissDuplicate() {
  const qc = useQueryClient();
  return useMutation<{ doc_id: number }, AxiosError<{ detail?: string }>, number>({
    mutationFn: dismissDuplicateRequest,
    onSuccess: (_data, docId) => {
      qc.invalidateQueries({ queryKey: ["library"] });
      qc.invalidateQueries({ queryKey: ["document-detail", docId] });
    },
  });
}

async function deleteDocumentRequest(docId: number): Promise<void> {
  await api.delete(`/documents/${docId}`);
}

export function useDeleteDocument() {
  const qc = useQueryClient();
  return useMutation<void, AxiosError<{ detail?: string }>, number>({
    mutationFn: deleteDocumentRequest,
    onSuccess: (_void, docId) => {
      // Delete pulls the row out of every list and the doc-detail cache.
      qc.invalidateQueries({ queryKey: ["library"] });
      qc.invalidateQueries({ queryKey: ["inbox"] });
      qc.invalidateQueries({ queryKey: ["in-flight"] });
      qc.removeQueries({ queryKey: ["document-detail", docId] });
    },
  });
}

// Status polling for the upload pipeline.

export type TaskStatus = {
  task_id: string;
  status: "PENDING" | "STARTED" | "SUCCESS" | "FAILURE" | "UNKNOWN";
  doc_id: number | null;
  result: string | null;
};

export type DocumentStatus = {
  id: number;
  lifecycle_tags: string[];
};

// Live snapshot of which doc ids the auto-tagger is on right now.
// Powered by /api/documents/processing → auto-tagger's in-memory state.
export type ProcessingState = {
  processing: number[];
  slots: {
    extraction: number | null;
    propagation: number | null;
    indexer: number | null;
  };
};

async function fetchProcessingState(): Promise<ProcessingState> {
  const { data } = await api.get<ProcessingState>("/documents/processing");
  return data;
}

export function useProcessingState() {
  // Poll every 5s — fast enough that the spinner appears within one
  // refresh tick of the auto-tagger starting on a new doc, slow enough
  // that we don't hammer the auto-tagger from 100 open browsers (was
  // 2s, which translated to ~30 req/min/tab on a multi-page session).
  // staleTime matches the interval so background re-renders don't kick
  // off extra fetches.
  return useQuery<ProcessingState, AxiosError>({
    queryKey: ["documents", "processing"],
    queryFn: fetchProcessingState,
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
    staleTime: 4000,
  });
}

/** True if `docId` is one of the ids the auto-tagger is on right now. */
export function isInFlight(
  docId: number,
  state: ProcessingState | undefined,
): boolean {
  return Boolean(state && state.processing.includes(docId));
}

// Full review payload for /library/$id (and any other "open this document"
// surface that needs more than the summary). Same shape as InboxDetail since
// both endpoints share aktenraum_api.inbox.service under the hood.
export type DocumentDetail = {
  id: number;
  title: string;
  original_file_name: string | null;
  created: string | null;
  ai_document_type: string | null;
  ai_correspondent: string | null;
  ai_title: string | null;
  ai_issue_date: string | null;
  ai_reference_numbers: string | null;
  ai_suggested_tags: string | null;
  ai_summary_de: string | null;
  ai_confidence: number | null;
  ai_backend: string | null;
  ai_model: string | null;
  ai_confidence_reason: string | null;
  low_confidence: boolean;
  tags: string[];
  content_excerpt: string;
  ai_error_message: string | null;
};

export type DocumentFieldUpdate = Partial<{
  ai_document_type: string | null;
  ai_correspondent: string | null;
  ai_title: string | null;
  ai_issue_date: string | null;
  ai_reference_numbers: string | null;
  ai_suggested_tags: string | null;
  ai_summary_de: string | null;
}>;

export async function fetchTaskStatus(taskId: string): Promise<TaskStatus> {
  const { data } = await api.get<TaskStatus>(`/documents/task/${taskId}`);
  return data;
}

export async function fetchDocumentStatus(
  docId: number,
): Promise<DocumentStatus> {
  const { data } = await api.get<DocumentStatus>(`/documents/${docId}/status`);
  return data;
}

async function fetchDocumentDetail(docId: number): Promise<DocumentDetail> {
  const { data } = await api.get<DocumentDetail>(`/documents/${docId}/detail`);
  return data;
}

async function patchDocumentFields(
  docId: number,
  body: DocumentFieldUpdate,
): Promise<DocumentDetail> {
  const { data } = await api.patch<DocumentDetail>(
    `/documents/${docId}/fields`,
    body,
  );
  return data;
}

export function useDocumentDetail(docId: number | null) {
  return useQuery<DocumentDetail, AxiosError>({
    queryKey: ["document-detail", docId],
    queryFn: () => fetchDocumentDetail(docId as number),
    enabled: docId !== null,
    staleTime: 0,
  });
}

export function useDocumentFieldsPatch(docId: number) {
  const qc = useQueryClient();
  return useMutation<
    DocumentDetail,
    AxiosError<{ detail?: string }>,
    DocumentFieldUpdate
  >({
    mutationFn: (body) => patchDocumentFields(docId, body),
    onSuccess: (data) => {
      // Snap the cache so the form re-renders with normalised values
      // (e.g. "01.12.2024" → "2024-12-01") without an extra round-trip.
      qc.setQueryData(["document-detail", docId], data);
      qc.invalidateQueries({ queryKey: ["library"] });
    },
  });
}

export type InFlightCount = { count: number };

export function useInFlightCount() {
  return useQuery<InFlightCount, AxiosError>({
    queryKey: ["in-flight"],
    queryFn: async () => {
      const { data } = await api.get<InFlightCount>("/documents/in-flight");
      return data;
    },
    // Refresh the badge every 30s while the page is open so background
    // pipeline progress shows up without a manual refetch.
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}
