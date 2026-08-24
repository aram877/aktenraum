import { inject, Injectable } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { lastValueFrom } from "rxjs";

export interface UploadResult {
  filename: string;
  status: "accepted" | "error";
  task_id?: string | null;
  detail?: string | null;
}

export interface UploadResponse {
  results: UploadResult[];
}

export interface TaskStatus {
  task_id: string;
  status: string;
  doc_id?: number | null;
  result?: string | null;
}

export interface DocumentStatus {
  id: number;
  lifecycle_tags: string[];
}

export type UploadPhase =
  | "ready"
  | "uploading"
  | "consuming"
  | "classifying"
  | "inbox"
  | "library"
  | "error";

export const PHASE_LABEL: Record<UploadPhase, string> = {
  ready: "Bereit",
  uploading: "Wird hochgeladen…",
  consuming: "Paperless verarbeitet…",
  classifying: "KI klassifiziert…",
  inbox: "✓ in der Inbox",
  library: "✓ in der Bibliothek",
  error: "✗ Fehler",
};

/** Map a document's lifecycle tags onto the terminal upload phase, or null while still in flight. */
export function phaseFromTags(tags: readonly string[]): UploadPhase | null {
  const set = new Set(tags);
  if (set.has("ai-error") || set.has("ai-propagation-error")) return "error";
  if (set.has("ai-pending")) return "inbox";
  if (set.has("ai-propagated") || set.has("ai-approved") || set.has("ai-rejected")) {
    return "library";
  }
  return null;
}

@Injectable({ providedIn: "root" })
export class UploadApi {
  private readonly http = inject(HttpClient);

  upload(files: readonly File[], title?: string): Promise<UploadResponse> {
    const form = new FormData();
    for (const file of files) form.append("files", file, file.name);
    if (title) form.append("title", title);
    return lastValueFrom(
      this.http.post<UploadResponse>("/api/documents/upload", form, {
        withCredentials: true,
      }),
    );
  }

  task(taskId: string): Promise<TaskStatus> {
    return lastValueFrom(
      this.http.get<TaskStatus>(`/api/documents/task/${taskId}`, { withCredentials: true }),
    );
  }

  status(docId: number): Promise<DocumentStatus> {
    return lastValueFrom(
      this.http.get<DocumentStatus>(`/api/documents/${docId}/status`, {
        withCredentials: true,
      }),
    );
  }
}
