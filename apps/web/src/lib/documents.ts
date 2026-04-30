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
    onSuccess: () => {
      // Reprocess pulls the doc out of /library and into /inbox; invalidate
      // both so the next visit shows the new state.
      qc.invalidateQueries({ queryKey: ["library"] });
      qc.invalidateQueries({ queryKey: ["inbox"] });
      qc.invalidateQueries({ queryKey: ["in-flight"] });
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
