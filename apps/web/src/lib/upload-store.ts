/**
 * Global upload store — keeps the per-file pipeline state alive while
 * the user navigates between pages. Plain `useState` inside the route
 * component drops everything on unmount; this lives at module scope.
 *
 * Design: module-level state + a `Set` of listeners, exposed to React
 * via `useSyncExternalStore`. No new dependency, identical semantics to
 * a Jotai atom for this single-purpose use case.
 *
 * What survives:
 *   - Switching to another route and back — uploads keep running, the
 *     UI re-renders from the store on remount.
 *   - Multiple tabs of the SAME page — they all read the same state.
 *
 * What doesn't survive: a full browser reload. Browsers don't let us
 * re-attach File handles after refresh, so the only reasonable behaviour
 * on reload is "those uploads either finished server-side or didn't —
 * check the library." Persisting an audit trail to localStorage is a
 * future enhancement; for now the store is in-memory only.
 */

import { useSyncExternalStore } from "react";

import type { AxiosError } from "axios";

import {
  fetchDocumentStatus,
  fetchTaskStatus,
  uploadDocument,
} from "./documents";

export type UploadPhase =
  | "queued"
  | "uploading"
  | "consuming"
  | "ai"
  | "inbox"
  | "library"
  | "error";

export type UploadEntry = {
  id: string;
  file: File;
  phase: UploadPhase;
  progress: number;
  taskId: string | null;
  docId: number | null;
  detail: string | null;
};

const TASK_POLL_MS = 1500;
const DOC_POLL_MS = 3000;
const MAX_POLL_MS = 120_000;

let entries: UploadEntry[] = [];
const listeners = new Set<() => void>();
const pollHandles = new Map<string, number>();

function notify() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): UploadEntry[] {
  return entries;
}

function makeId(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`;
}

function setEntry(id: string, patch: Partial<UploadEntry>): void {
  entries = entries.map((e) => (e.id === id ? { ...e, ...patch } : e));
  notify();
}

function cancelPoll(id: string): void {
  const h = pollHandles.get(id);
  if (h !== undefined) {
    window.clearTimeout(h);
    pollHandles.delete(id);
  }
}

export function enqueue(files: File[]): void {
  if (files.length === 0) return;
  const next: UploadEntry[] = files.map((f) => ({
    id: makeId(f),
    file: f,
    phase: "queued",
    progress: 0,
    taskId: null,
    docId: null,
    detail: null,
  }));
  entries = [...entries, ...next];
  notify();
}

export function clearAll(): void {
  for (const id of Array.from(pollHandles.keys())) cancelPoll(id);
  entries = [];
  notify();
}

/**
 * Drop only terminal rows (success or error). In-flight uploads keep
 * running. Useful for "tidy up after the batch is done."
 */
export function clearTerminal(): void {
  entries = entries.filter(
    (e) =>
      e.phase !== "inbox" && e.phase !== "library" && e.phase !== "error",
  );
  notify();
}

function startTaskPoll(id: string, taskId: string, startedAt: number): void {
  const tick = async () => {
    if (!entries.some((e) => e.id === id)) {
      cancelPoll(id);
      return;
    }
    if (Date.now() - startedAt > MAX_POLL_MS) {
      setEntry(id, { phase: "error", detail: "Zeitüberschreitung" });
      return;
    }
    try {
      const status = await fetchTaskStatus(taskId);
      if (status.status === "SUCCESS" && status.doc_id) {
        setEntry(id, { phase: "ai", docId: status.doc_id });
        startDocPoll(id, status.doc_id, startedAt);
        return;
      }
      if (status.status === "FAILURE") {
        setEntry(id, {
          phase: "error",
          detail: status.result ?? "Paperless-Konsumierung fehlgeschlagen",
        });
        return;
      }
    } catch {
      // transient — retry on next tick
    }
    const handle = window.setTimeout(tick, TASK_POLL_MS);
    pollHandles.set(id, handle);
  };
  const handle = window.setTimeout(tick, TASK_POLL_MS);
  pollHandles.set(id, handle);
}

function startDocPoll(id: string, docId: number, startedAt: number): void {
  const tick = async () => {
    if (!entries.some((e) => e.id === id)) {
      cancelPoll(id);
      return;
    }
    if (Date.now() - startedAt > MAX_POLL_MS) {
      setEntry(id, {
        phase: "error",
        detail: "KI-Pipeline reagiert langsam — schau in die Bibliothek.",
      });
      return;
    }
    try {
      const status = await fetchDocumentStatus(docId);
      const tags = new Set(status.lifecycle_tags);
      if (tags.has("ai-pending")) {
        setEntry(id, { phase: "inbox" });
        return;
      }
      if (tags.has("ai-propagated") || tags.has("ai-approved")) {
        setEntry(id, { phase: "library" });
        return;
      }
      if (tags.has("ai-error") || tags.has("ai-propagation-error")) {
        setEntry(id, {
          phase: "error",
          detail: "KI-Klassifizierung fehlgeschlagen",
        });
        return;
      }
    } catch {
      // ignore transient
    }
    const handle = window.setTimeout(tick, DOC_POLL_MS);
    pollHandles.set(id, handle);
  };
  const handle = window.setTimeout(tick, DOC_POLL_MS);
  pollHandles.set(id, handle);
}

/**
 * Kick off uploads for every `queued` entry, sequentially. Subsequent
 * lifecycle polls run independently in the background.
 *
 * Sequential (not parallel) by design — Paperless's consumer queue is
 * also serial, so firing 20 multipart POSTs at once just pads the
 * queue without speeding anything up.
 */
export async function startUpload(): Promise<void> {
  const queued = entries.filter((e) => e.phase === "queued");
  for (const item of queued) {
    setEntry(item.id, { phase: "uploading", progress: 0 });
    try {
      const resp = await uploadDocument({
        file: item.file,
        onProgress: (pct) => setEntry(item.id, { progress: pct }),
      });
      const result = resp.results[0];
      if (result?.status === "accepted" && result.task_id) {
        setEntry(item.id, {
          phase: "consuming",
          taskId: result.task_id,
          progress: 100,
        });
        startTaskPoll(item.id, result.task_id, Date.now());
      } else {
        setEntry(item.id, {
          phase: "error",
          detail: result?.detail ?? "Unbekannter Fehler",
        });
      }
    } catch (e) {
      const err = e as AxiosError<{ detail?: string }>;
      setEntry(item.id, {
        phase: "error",
        detail:
          err.response?.data?.detail ?? err.message ?? "Upload fehlgeschlagen",
      });
    }
  }
}

export function useUploads(): UploadEntry[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** True iff any upload is still in flight (not yet terminal). */
export function isUploadInFlight(list: UploadEntry[]): boolean {
  return list.some(
    (e) =>
      e.phase === "queued" ||
      e.phase === "uploading" ||
      e.phase === "consuming" ||
      e.phase === "ai",
  );
}
