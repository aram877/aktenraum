import { useMutation, useQueryClient } from "@tanstack/react-query";
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
    },
  });
}
