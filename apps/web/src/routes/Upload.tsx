import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { Nav } from "../components/Nav";
import { uploadDocument } from "../lib/documents";

type FileState = {
  id: string;
  file: File;
  status: "queued" | "uploading" | "accepted" | "error";
  progress: number;
  detail: string | null;
};

export function Upload() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<FileState[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const queueFiles = (incoming: File[]) => {
    if (incoming.length === 0) return;
    const next: FileState[] = incoming.map((f) => ({
      id: `${f.name}-${f.size}-${f.lastModified}-${Math.random()}`,
      file: f,
      status: "queued",
      progress: 0,
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
    setFiles((cur) =>
      cur.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    );
  };

  const startUpload = async () => {
    const queued = files.filter((f) => f.status === "queued");
    for (const item of queued) {
      setFileState(item.id, { status: "uploading", progress: 0 });
      try {
        const resp = await uploadDocument({
          file: item.file,
          onProgress: (pct) => setFileState(item.id, { progress: pct }),
        });
        const result = resp.results[0];
        if (result?.status === "accepted") {
          setFileState(item.id, {
            status: "accepted",
            progress: 100,
            detail: result.task_id,
          });
        } else {
          setFileState(item.id, {
            status: "error",
            detail: result?.detail ?? "Unbekannter Fehler",
          });
        }
      } catch (e) {
        const err = e as { response?: { data?: { detail?: string } }; message?: string };
        setFileState(item.id, {
          status: "error",
          detail: err.response?.data?.detail ?? err.message ?? "Upload fehlgeschlagen",
        });
      }
    }
  };

  const allDone =
    files.length > 0 &&
    files.every((f) => f.status === "accepted" || f.status === "error");
  const acceptedCount = files.filter((f) => f.status === "accepted").length;
  const queuedCount = files.filter((f) => f.status === "queued").length;
  const uploading = files.some((f) => f.status === "uploading");

  return (
    <div className="flex min-h-full flex-col">
      <Nav active="upload" />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
        <h1 className="text-lg font-semibold tracking-tight">
          Dokumente hochladen
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Lege PDFs oder Bilder ab. Sie werden in Paperless eingespielt und
          danach automatisch von der KI klassifiziert — du findest sie dann in
          der Inbox zur Prüfung.
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
              <li
                key={f.id}
                className="flex items-center gap-3 px-4 py-3 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-neutral-900">
                    {f.file.name}
                  </div>
                  <div className="text-xs text-neutral-500">
                    {humanSize(f.file.size)} · <Status state={f} />
                  </div>
                  {f.status === "uploading" && (
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-neutral-200">
                      <div
                        className="h-full bg-neutral-900 transition-all"
                        style={{ width: `${f.progress}%` }}
                      />
                    </div>
                  )}
                </div>
              </li>
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
            {allDone && acceptedCount > 0 && (
              <button
                type="button"
                onClick={() => navigate({ to: "/inbox" })}
                className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-neutral-100"
              >
                Zur Inbox →
              </button>
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

        {allDone && (
          <p className="mt-4 text-xs text-neutral-500">
            Tipp: Die Inbox füllt sich erst, wenn die Auto-Tagger-Pipeline mit
            der Klassifizierung fertig ist (typisch wenige Sekunden bis ~30s).
            Bei Verspätung hilft <Link className="underline" to="/library">die Bibliothek</Link>.
          </p>
        )}
      </main>
    </div>
  );
}

function Status({ state }: { state: FileState }) {
  if (state.status === "queued") return <span>bereit</span>;
  if (state.status === "uploading") return <span>{state.progress}%</span>;
  if (state.status === "accepted")
    return (
      <span className="text-emerald-700">
        ✓ angenommen{state.detail ? ` (Task ${state.detail.slice(0, 8)}…)` : ""}
      </span>
    );
  return (
    <span className="text-red-700">
      ✗ {state.detail ?? "Fehler"}
    </span>
  );
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
