import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { Nav } from "../components/Nav";
import {
  fetchDocumentStatus,
  fetchTaskStatus,
  uploadDocument,
} from "../lib/documents";

type Phase =
  | "queued" // sitting in the form, not yet uploaded
  | "uploading" // bytes streaming up
  | "consuming" // Paperless task PENDING/STARTED
  | "ai" // task SUCCESS, no lifecycle tag yet
  | "inbox" // ai-pending
  | "library" // ai-propagated / ai-approved
  | "error";

type FileState = {
  id: string;
  file: File;
  phase: Phase;
  progress: number; // 0..100 during "uploading"
  taskId: string | null;
  docId: number | null;
  detail: string | null;
  pollHandle?: number;
};

const PHASE_COPY: Record<Phase, { label: string; tone: string }> = {
  queued: { label: "Bereit", tone: "text-neutral-500" },
  uploading: { label: "Wird hochgeladen", tone: "text-neutral-700" },
  consuming: { label: "Paperless verarbeitet…", tone: "text-blue-700" },
  ai: { label: "KI klassifiziert…", tone: "text-amber-700" },
  inbox: { label: "✓ Zur Prüfung", tone: "text-emerald-700" },
  library: { label: "✓ in der Bibliothek", tone: "text-emerald-700" },
  error: { label: "✗ Fehler", tone: "text-red-700" },
};

// Phase polling cadence + ceiling. Personal scale; we want fast snap-to-state
// without spamming the API. The 120s ceiling covers OCR + LLM + propagation
// for typical PDFs; longer-running pipelines (heavy tika parses) just stay
// "AI klassifiziert…" until the user refreshes.
const TASK_POLL_MS = 1500;
const DOC_POLL_MS = 3000;
const MAX_POLL_MS = 120_000;

export function Upload() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<FileState[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const pollTimers = useRef<Map<string, number>>(new Map());

  // Cancel any in-flight pollers when the page unmounts.
  useEffect(() => {
    const timers = pollTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const queueFiles = (incoming: File[]) => {
    if (incoming.length === 0) return;
    const next: FileState[] = incoming.map((f) => ({
      id: `${f.name}-${f.size}-${f.lastModified}-${Math.random()}`,
      file: f,
      phase: "queued",
      progress: 0,
      taskId: null,
      docId: null,
      detail: null,
    }));
    setFiles((cur) => [...cur, ...next]);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    queueFiles(Array.from(e.dataTransfer.files));
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    queueFiles(Array.from(e.target.files ?? []));
    if (inputRef.current) inputRef.current.value = "";
  };

  const setFileState = (id: string, patch: Partial<FileState>) => {
    setFiles((cur) => cur.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  };

  const startUpload = async () => {
    const queued = files.filter((f) => f.phase === "queued");
    for (const item of queued) {
      setFileState(item.id, { phase: "uploading", progress: 0 });
      try {
        const resp = await uploadDocument({
          file: item.file,
          onProgress: (pct) => setFileState(item.id, { progress: pct }),
        });
        const result = resp.results[0];
        if (result?.status === "accepted" && result.task_id) {
          setFileState(item.id, {
            phase: "consuming",
            taskId: result.task_id,
            progress: 100,
          });
          startTaskPoll(item.id, result.task_id, Date.now());
        } else {
          setFileState(item.id, {
            phase: "error",
            detail: result?.detail ?? "Unbekannter Fehler",
          });
        }
      } catch (e) {
        const err = e as { response?: { data?: { detail?: string } }; message?: string };
        setFileState(item.id, {
          phase: "error",
          detail: err.response?.data?.detail ?? err.message ?? "Upload fehlgeschlagen",
        });
      }
    }
  };

  // Poll the Paperless task until it succeeds (→ doc id known) or fails.
  // Then hand off to startDocPoll for the lifecycle-tag stage.
  const startTaskPoll = (id: string, taskId: string, startedAt: number) => {
    const tick = async () => {
      if (Date.now() - startedAt > MAX_POLL_MS) {
        setFileState(id, { phase: "error", detail: "Zeitüberschreitung" });
        return;
      }
      try {
        const status = await fetchTaskStatus(taskId);
        if (status.status === "SUCCESS" && status.doc_id) {
          setFileState(id, { phase: "ai", docId: status.doc_id });
          startDocPoll(id, status.doc_id, startedAt);
          return;
        }
        if (status.status === "FAILURE") {
          setFileState(id, {
            phase: "error",
            detail: status.result ?? "Paperless-Konsumierung fehlgeschlagen",
          });
          return;
        }
        // PENDING / STARTED / UNKNOWN → keep polling.
      } catch {
        // Transient — try again on the next tick rather than failing the file.
      }
      const handle = window.setTimeout(tick, TASK_POLL_MS);
      pollTimers.current.set(id, handle);
    };
    const handle = window.setTimeout(tick, TASK_POLL_MS);
    pollTimers.current.set(id, handle);
  };

  // Poll the document's lifecycle tag until a state we can render appears.
  const startDocPoll = (id: string, docId: number, startedAt: number) => {
    const tick = async () => {
      if (Date.now() - startedAt > MAX_POLL_MS) {
        // Pipeline is unusually slow; the user can find the doc in the
        // library or refresh later — flag it but don't error.
        setFileState(id, {
          phase: "error",
          detail: "KI-Pipeline reagiert langsam — schau in die Bibliothek.",
        });
        return;
      }
      try {
        const status = await fetchDocumentStatus(docId);
        const tags = new Set(status.lifecycle_tags);
        if (tags.has("ai-pending")) {
          setFileState(id, { phase: "inbox" });
          return;
        }
        if (tags.has("ai-propagated") || tags.has("ai-approved")) {
          setFileState(id, { phase: "library" });
          return;
        }
        if (tags.has("ai-error") || tags.has("ai-propagation-error")) {
          setFileState(id, {
            phase: "error",
            detail: "KI-Klassifizierung fehlgeschlagen",
          });
          return;
        }
      } catch {
        // ignore transient
      }
      const handle = window.setTimeout(tick, DOC_POLL_MS);
      pollTimers.current.set(id, handle);
    };
    const handle = window.setTimeout(tick, DOC_POLL_MS);
    pollTimers.current.set(id, handle);
  };

  const allTerminal =
    files.length > 0 &&
    files.every((f) =>
      f.phase === "inbox" || f.phase === "library" || f.phase === "error",
    );
  const queuedCount = files.filter((f) => f.phase === "queued").length;
  const uploading = files.some(
    (f) => f.phase === "uploading" || f.phase === "consuming" || f.phase === "ai",
  );
  const inboxCount = files.filter((f) => f.phase === "inbox").length;

  return (
    <div className="flex min-h-full flex-col">
      <Nav active="upload" />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
        <h1 className="text-lg font-semibold tracking-tight">
          Dokumente hochladen
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Lege PDFs oder Bilder ab. Sie werden in Paperless eingespielt und
          danach automatisch von der KI klassifiziert. Du verfolgst hier den
          Fortschritt live.
        </p>

        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          htmlFor="file-input"
          className={`mt-6 flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center text-sm transition ${
            dragOver
              ? "border-neutral-900 bg-neutral-50"
              : "border-neutral-300 bg-white hover:bg-neutral-50"
          }`}
        >
          <span className="font-medium text-neutral-900">
            Hier ablegen oder klicken zum Auswählen
          </span>
          <span className="mt-1 text-xs text-neutral-500">
            Mehrere Dateien gleichzeitig sind erlaubt.
          </span>
          <input
            id="file-input"
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={onPick}
          />
        </label>

        {files.length > 0 && (
          <ul className="mt-4 divide-y divide-neutral-200 rounded-md border border-neutral-200 bg-white">
            {files.map((f) => (
              <FileRow key={f.id} state={f} />
            ))}
          </ul>
        )}

        <div className="mt-4 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setFiles([])}
            disabled={files.length === 0 || uploading}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
          >
            Liste leeren
          </button>

          <div className="flex items-center gap-3">
            {allTerminal && inboxCount > 0 && (
              <button
                type="button"
                onClick={() => navigate({ to: "/library", search: { tab: "review" } })}
                className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-neutral-100"
              >
                Zur Prüfung →
              </button>
            )}
            {allTerminal && inboxCount === 0 && (
              <Link
                to="/library"
                className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-neutral-100"
              >
                Zur Bibliothek →
              </Link>
            )}
            <button
              type="button"
              onClick={startUpload}
              disabled={queuedCount === 0 || uploading}
              className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60"
            >
              {uploading
                ? "Lädt hoch…"
                : queuedCount > 0
                  ? `Hochladen (${queuedCount})`
                  : "Hochladen"}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

function FileRow({ state }: { state: FileState }) {
  const { tone, label } = PHASE_COPY[state.phase];
  const showProgress = state.phase === "uploading";
  const showDocLink =
    (state.phase === "inbox" || state.phase === "library") && state.docId !== null;

  return (
    <li className="flex items-center gap-3 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-neutral-900">
            {state.file.name}
          </span>
          {showDocLink && state.docId !== null && (
            <Link
              to="/library/$id"
              params={{ id: String(state.docId) }}
              className="text-xs text-neutral-500 underline hover:text-neutral-900"
            >
              #{state.docId}
            </Link>
          )}
        </div>
        <div className="text-xs">
          <span className="text-neutral-500">{humanSize(state.file.size)} · </span>
          <span className={tone}>{label}</span>
          {state.detail && state.phase === "error" && (
            <span className="ml-1 text-red-700">
              — <DuplicateDetail detail={state.detail} />
            </span>
          )}
        </div>
        {showProgress && (
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-neutral-200">
            <div
              className="h-full bg-neutral-900 transition-all"
              style={{ width: `${state.progress}%` }}
            />
          </div>
        )}
        {(state.phase === "consuming" || state.phase === "ai") && (
          <div className="mt-1 h-1 w-24 animate-pulse rounded-full bg-neutral-200" />
        )}
      </div>
    </li>
  );
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Renders error detail text, turning a Paperless duplicate notice like
// "It is a duplicate of SomeName (#81)." into clickable link on the #81 part.
function DuplicateDetail({ detail }: { detail: string }) {
  const match = detail.match(/#(\d+)/);
  if (!match || !match[1]) return <>{detail}</>;
  const docId: string = match[1];
  const idx = detail.indexOf(match[0]);
  const before = detail.slice(0, idx);
  const after = detail.slice(idx + match[0].length);
  return (
    <>
      {before}
      <Link
        to="/library/$id"
        params={{ id: docId }}
        className="font-medium underline hover:text-red-900"
      >
        #{docId}
      </Link>
      {after}
    </>
  );
}
