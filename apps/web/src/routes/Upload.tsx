import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { Nav } from "../components/Nav";
import {
  clearAll,
  enqueue,
  startUpload as startUploadDriver,
  useUploads,
  type UploadEntry,
  type UploadPhase,
} from "../lib/upload-store";

const PHASE_COPY: Record<UploadPhase, { label: string; tone: string }> = {
  queued: { label: "Bereit", tone: "text-ink-subtle" },
  uploading: { label: "Wird hochgeladen", tone: "text-ink-muted" },
  consuming: { label: "Paperless verarbeitet…", tone: "text-accent" },
  ai: { label: "KI klassifiziert…", tone: "text-amber-700" },
  inbox: { label: "✓ Zur Prüfung", tone: "text-emerald-700" },
  library: { label: "✓ in der Bibliothek", tone: "text-emerald-700" },
  error: { label: "✗ Fehler", tone: "text-red-700" },
};

export function Upload() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Upload state lives in a module-level store so it survives route
  // changes — open /upload, queue 100 files, navigate to /library, come
  // back, the list is still there and the polls are still ticking.
  const files = useUploads();

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    enqueue(Array.from(e.dataTransfer.files));
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    enqueue(Array.from(e.target.files ?? []));
    if (inputRef.current) inputRef.current.value = "";
  };

  const allTerminal =
    files.length > 0 &&
    files.every(
      (f) =>
        f.phase === "inbox" || f.phase === "library" || f.phase === "error",
    );
  const queuedCount = files.filter((f) => f.phase === "queued").length;
  const uploading = files.some(
    (f) =>
      f.phase === "uploading" ||
      f.phase === "consuming" ||
      f.phase === "ai",
  );
  const inboxCount = files.filter((f) => f.phase === "inbox").length;

  return (
    <div className="flex min-h-full flex-col">
      <Nav active="upload" />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
        <h1 className="text-lg font-semibold tracking-tight text-ink">
          Dokumente hochladen
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Lege PDFs oder Bilder ab. Sie werden in Paperless eingespielt und danach
          automatisch von der KI klassifiziert. Du verfolgst hier den Fortschritt live.
        </p>

        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          htmlFor="file-input"
          className={`mt-6 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center text-sm transition-colors ${
            dragOver
              ? "border-accent bg-accent/5"
              : "border-hairline bg-surface hover:border-hairline-soft hover:bg-canvas"
          }`}
        >
          <span className="font-medium text-ink">
            Hier ablegen oder klicken zum Auswählen
          </span>
          <span className="mt-1 text-xs text-ink-subtle">
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
          <ul className="mt-4 divide-y divide-hairline-soft rounded-lg border border-hairline bg-surface">
            {files.map((f) => (
              <FileRow key={f.id} state={f} />
            ))}
          </ul>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={clearAll}
            disabled={files.length === 0 || uploading}
            className="rounded-md border border-hairline bg-surface px-3 py-2 text-sm font-medium text-ink-muted hover:bg-canvas disabled:opacity-50"
          >
            Liste leeren
          </button>

          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
            {allTerminal && inboxCount > 0 && (
              <button
                type="button"
                onClick={() =>
                  navigate({ to: "/library", search: { tab: "review" } })
                }
                className="rounded-md border border-hairline bg-surface px-3 py-2 text-sm font-medium text-ink-muted hover:bg-canvas"
              >
                Zur Prüfung →
              </button>
            )}
            {allTerminal && inboxCount === 0 && (
              <Link
                to="/library"
                className="rounded-md border border-hairline bg-surface px-3 py-2 text-sm font-medium text-ink-muted hover:bg-canvas"
              >
                Zur Bibliothek →
              </Link>
            )}
            <button
              type="button"
              onClick={() => void startUploadDriver()}
              disabled={queuedCount === 0 || uploading}
              className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-on-inverse hover:opacity-80 disabled:opacity-60"
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

function FileRow({ state }: { state: UploadEntry }) {
  const { tone, label } = PHASE_COPY[state.phase];
  const showProgress = state.phase === "uploading";
  const showDocLink =
    (state.phase === "inbox" || state.phase === "library") &&
    state.docId !== null;

  return (
    <li className="flex items-center gap-3 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-ink">{state.file.name}</span>
          {showDocLink && state.docId !== null && (
            <Link
              to="/library/$id"
              params={{ id: String(state.docId) }}
              className="text-xs text-ink-subtle underline hover:text-ink"
            >
              #{state.docId}
            </Link>
          )}
        </div>
        <div className="text-xs">
          <span className="text-ink-faint">{humanSize(state.file.size)} · </span>
          <span className={tone}>{label}</span>
          {state.detail && state.phase === "error" && (
            <span className="ml-1 text-red-700">
              — <DuplicateDetail detail={state.detail} />
            </span>
          )}
        </div>
        {showProgress && (
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-raised">
            <div
              className="h-full bg-ink transition-all"
              style={{ width: `${state.progress}%` }}
            />
          </div>
        )}
        {(state.phase === "consuming" || state.phase === "ai") && (
          <div className="mt-1.5 h-1 w-24 animate-pulse rounded-full bg-surface-raised" />
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
