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

export function useUploadApi() {
  const api = useApi();
  return {
    upload(files: readonly File[], title?: string): Promise<UploadResponse> {
      const form = new FormData();
      for (const file of files) form.append("files", file, file.name);
      if (title) form.append("title", title);
      return api.upload<UploadResponse>("/documents/upload", form);
    },
    task: (taskId: string) => api.get<TaskStatus>(`/documents/task/${taskId}`),
    status: (docId: number) => api.get<DocumentStatus>(`/documents/${docId}/status`),
  };
}

export interface FileState {
  name: string;
  phase: UploadPhase;
  detail: string | null;
  docId: number | null;
}

export const TASK_POLL_MS = 1500;
export const STATUS_POLL_MS = 3000;
export const POLL_CEILING_MS = 120_000;

export function useUploadTracker() {
  const api = useUploadApi();
  const files = ref<readonly FileState[]>([]);
  const busy = ref(false);
  let cancelled = false;

  onBeforeUnmount(() => {
    cancelled = true;
  });

  function update(name: string, patch: Partial<FileState>): void {
    files.value = files.value.map((f) => (f.name === name ? { ...f, ...patch } : f));
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function track(filename: string, taskId: string): Promise<void> {
    const deadline = Date.now() + POLL_CEILING_MS;
    let docId: number | null = null;
    while (!cancelled && Date.now() < deadline && docId === null) {
      await wait(TASK_POLL_MS);
      if (cancelled) return;
      try {
        const task = await api.task(taskId);
        if (task.status === "SUCCESS" && task.doc_id) docId = task.doc_id;
        else if (task.status === "FAILURE") {
          update(filename, { phase: "error", detail: task.result ?? null });
          return;
        }
      } catch {
        continue;
      }
    }
    if (docId === null) return;
    update(filename, { phase: "classifying", docId });

    while (!cancelled && Date.now() < deadline) {
      await wait(STATUS_POLL_MS);
      if (cancelled) return;
      try {
        const status = await api.status(docId);
        const phase = phaseFromTags(status.lifecycle_tags);
        if (phase !== null) {
          update(filename, { phase });
          return;
        }
      } catch {
        continue;
      }
    }
  }

  async function send(picked: File[]): Promise<void> {
    busy.value = true;
    files.value = picked.map((f) => ({ name: f.name, phase: "uploading", detail: null, docId: null }));
    try {
      const response = await api.upload(picked);
      for (const result of response.results) {
        if (result.status === "error") {
          update(result.filename, { phase: "error", detail: result.detail ?? null });
          continue;
        }
        update(result.filename, { phase: "consuming" });
        if (result.task_id) void track(result.filename, result.task_id);
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      files.value = files.value.map((f) => ({ ...f, phase: "error", detail }));
    } finally {
      busy.value = false;
    }
  }

  return { files, busy, send };
}
