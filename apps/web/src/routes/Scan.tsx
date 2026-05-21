import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useReducer, useRef, useState } from "react";

import { CornerAdjusterModal } from "../components/CornerAdjusterModal";
import { Nav } from "../components/Nav";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CameraIcon,
  CropIcon,
  RotateIcon,
  TrashIcon,
} from "../components/Icons";
import {
  fetchDocumentStatus,
  fetchTaskStatus,
  uploadDocument,
} from "../lib/documents";
import { formatLocalIso, pagesToPdf } from "../lib/scan-pdf";
import { scanReducer } from "../lib/scan-reducer";
import {
  initialScanState,
  MAX_PAGES,
  type ScanPage,
} from "../lib/scan-types";

type Phase =
  | "idle"
  | "composing"
  | "uploading"
  | "consuming"
  | "ai"
  | "inbox"
  | "library"
  | "error";

const PHASE_COPY: Record<Phase, { label: string; tone: string }> = {
  idle: { label: "", tone: "" },
  composing: { label: "PDF wird erzeugt…", tone: "text-ink-muted" },
  uploading: { label: "Wird hochgeladen", tone: "text-ink-muted" },
  consuming: { label: "Paperless verarbeitet…", tone: "text-accent" },
  ai: { label: "KI klassifiziert…", tone: "text-amber-700" },
  inbox: { label: "✓ Zur Prüfung", tone: "text-emerald-700" },
  library: { label: "✓ in der Bibliothek", tone: "text-emerald-700" },
  error: { label: "✗ Fehler", tone: "text-red-700" },
};

const TASK_POLL_MS = 1500;
const DOC_POLL_MS = 3000;
const MAX_POLL_MS = 120_000;

export function Scan() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [state, dispatch] = useReducer(scanReducer, initialScanState);
  const [filename, setFilename] = useState(
    () => `scan-${formatLocalIso(new Date())}`,
  );
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [docId, setDocId] = useState<number | null>(null);
  const [adjustTargetId, setAdjustTargetId] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);
  const lastSeenLen = useRef(0);

  useEffect(() => {
    return () => {
      if (pollTimer.current !== null) clearTimeout(pollTimer.current);
    };
  }, []);

  // Auto-open the corner adjuster on the most-recently-added page so the
  // perspective correction step lives inside the capture flow rather than
  // hidden behind a per-tile button. Tracks page count so adjuster
  // re-opens on every fresh capture (but not on rotate / reorder / etc.).
  useEffect(() => {
    if (state.pages.length > lastSeenLen.current) {
      const last = state.pages[state.pages.length - 1];
      if (last) setAdjustTargetId(last.id);
    }
    lastSeenLen.current = state.pages.length;
  }, [state.pages]);

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    for (const f of files) {
      if (state.pages.length >= MAX_PAGES) break;
      dispatch({ type: "add", blob: f });
    }
    if (inputRef.current) inputRef.current.value = "";
  };

  const startUpload = async () => {
    if (state.pages.length === 0) return;
    setPhase("composing");
    setErrorDetail(null);
    setProgress(0);
    try {
      const pdf = await pagesToPdf(state.pages);
      const safeName = filename.trim() || `scan-${formatLocalIso(new Date())}`;
      const file = new File([pdf], `${safeName}.pdf`, {
        type: "application/pdf",
      });
      setPhase("uploading");
      const resp = await uploadDocument({
        file,
        onProgress: (pct) => setProgress(pct),
      });
      const result = resp.results[0];
      if (result?.status === "accepted" && result.task_id) {
        setPhase("consuming");
        setTaskId(result.task_id);
        setProgress(100);
        startTaskPoll(result.task_id, Date.now());
      } else {
        setPhase("error");
        setErrorDetail(result?.detail ?? "Unbekannter Fehler");
      }
    } catch (e) {
      const err = e as {
        response?: { data?: { detail?: string } };
        message?: string;
      };
      setPhase("error");
      setErrorDetail(
        err.response?.data?.detail ?? err.message ?? "Upload fehlgeschlagen",
      );
    }
  };

  const startTaskPoll = (tid: string, startedAt: number) => {
    const tick = async () => {
      if (Date.now() - startedAt > MAX_POLL_MS) {
        setPhase("error");
        setErrorDetail("Zeitüberschreitung");
        return;
      }
      try {
        const status = await fetchTaskStatus(tid);
        if (status.status === "SUCCESS" && status.doc_id) {
          setPhase("ai");
          setDocId(status.doc_id);
          startDocPoll(status.doc_id, startedAt);
          return;
        }
        if (status.status === "FAILURE") {
          setPhase("error");
          setErrorDetail(
            status.result ?? "Paperless-Konsumierung fehlgeschlagen",
          );
          return;
        }
      } catch {
        // transient — retry
      }
      pollTimer.current = window.setTimeout(tick, TASK_POLL_MS);
    };
    pollTimer.current = window.setTimeout(tick, TASK_POLL_MS);
  };

  const startDocPoll = (id: number, startedAt: number) => {
    const tick = async () => {
      if (Date.now() - startedAt > MAX_POLL_MS) {
        setPhase("error");
        setErrorDetail(
          "KI-Pipeline reagiert langsam — schau in die Bibliothek.",
        );
        return;
      }
      try {
        const status = await fetchDocumentStatus(id);
        const tags = new Set(status.lifecycle_tags);
        if (tags.has("ai-pending")) {
          setPhase("inbox");
          return;
        }
        if (tags.has("ai-propagated") || tags.has("ai-approved")) {
          setPhase("library");
          return;
        }
        if (tags.has("ai-error") || tags.has("ai-propagation-error")) {
          setPhase("error");
          setErrorDetail("KI-Klassifizierung fehlgeschlagen");
          return;
        }
      } catch {
        // ignore transient
      }
      pollTimer.current = window.setTimeout(tick, DOC_POLL_MS);
    };
    pollTimer.current = window.setTimeout(tick, DOC_POLL_MS);
  };

  const resetForNewScan = () => {
    if (pollTimer.current !== null) clearTimeout(pollTimer.current);
    pollTimer.current = null;
    for (const p of state.pages) dispatch({ type: "remove", id: p.id });
    setPhase("idle");
    setProgress(0);
    setErrorDetail(null);
    setTaskId(null);
    setDocId(null);
    setFilename(`scan-${formatLocalIso(new Date())}`);
  };

  const pages = state.pages;
  const busy =
    phase === "composing" ||
    phase === "uploading" ||
    phase === "consuming" ||
    phase === "ai";
  const terminal =
    phase === "inbox" || phase === "library" || phase === "error";

  const adjustTarget = adjustTargetId
    ? pages.find((p) => p.id === adjustTargetId)
    : null;

  return (
    <div className="flex min-h-full flex-col">
      <Nav active="scan" />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <h1 className="text-lg font-semibold tracking-tight text-ink">
          Scannen
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Fotografiere Seite für Seite. Nach jeder Aufnahme erkennen wir die
          Dokumentkanten automatisch — ziehe die Ecken bei Bedarf zurecht.
          Anschließend kannst du Seiten drehen, neu anordnen oder löschen.
          Beim Hochladen werden alle Seiten zu einem PDF zusammengefasst und
          gelangen in die KI-Pipeline.
        </p>

        {!terminal && (
          <>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={busy || pages.length >= MAX_PAGES}
                className="inline-flex items-center justify-center gap-2 rounded-md bg-ink px-4 py-3 text-sm font-medium text-on-inverse hover:opacity-80 disabled:opacity-60"
              >
                <CameraIcon className="h-4 w-4" />
                {pages.length === 0 ? "Seite aufnehmen" : "Weitere Seite"}
              </button>
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={onPick}
              />
              <div className="text-xs text-ink-subtle">
                {pages.length === 0
                  ? "Noch keine Seiten."
                  : `${pages.length} Seite${pages.length === 1 ? "" : "n"}${
                      pages.length >= MAX_PAGES ? ` (Maximum erreicht)` : ""
                    }`}
              </div>
            </div>

            {pages.length > 0 && (
              <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {pages.map((page, idx) => (
                  <PageTile
                    key={page.id}
                    page={page}
                    index={idx}
                    total={pages.length}
                    onRotate={() => dispatch({ type: "rotate", id: page.id })}
                    onCrop={() => setAdjustTargetId(page.id)}
                    onRemove={() => dispatch({ type: "remove", id: page.id })}
                    onMoveUp={() =>
                      dispatch({
                        type: "reorder",
                        from: idx,
                        to: idx - 1,
                      })
                    }
                    onMoveDown={() =>
                      dispatch({
                        type: "reorder",
                        from: idx,
                        to: idx + 1,
                      })
                    }
                  />
                ))}
              </ul>
            )}

            <div className="mt-6 grid gap-4">
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-ink">Dateiname</span>
                <div className="flex items-center gap-2 rounded-md border border-hairline bg-surface px-3 py-2">
                  <input
                    type="text"
                    value={filename}
                    onChange={(e) => setFilename(e.target.value)}
                    disabled={busy}
                    className="flex-1 bg-transparent text-sm text-ink outline-none disabled:opacity-60"
                    placeholder="scan-2026-05-21-104530"
                  />
                  <span className="text-xs text-ink-subtle">.pdf</span>
                </div>
              </label>

              {busy && phase === "uploading" && (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-raised">
                  <div
                    className="h-full bg-ink transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              )}

              {busy &&
                (phase === "composing" ||
                  phase === "consuming" ||
                  phase === "ai") && (
                  <div className="flex items-center gap-2 text-sm text-ink-muted">
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
                    {PHASE_COPY[phase].label}
                  </div>
                )}

              <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
                <button
                  type="button"
                  onClick={resetForNewScan}
                  disabled={pages.length === 0 || busy}
                  className="rounded-md border border-hairline bg-surface px-3 py-2 text-sm font-medium text-ink-muted hover:bg-canvas disabled:opacity-50"
                >
                  Verwerfen
                </button>
                <button
                  type="button"
                  onClick={startUpload}
                  disabled={pages.length === 0 || busy}
                  className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-on-inverse hover:opacity-80 disabled:opacity-60"
                >
                  {busy
                    ? PHASE_COPY[phase].label
                    : `Hochladen (${pages.length} Seite${
                        pages.length === 1 ? "" : "n"
                      })`}
                </button>
              </div>
            </div>
          </>
        )}

        {terminal && (
          <TerminalSummary
            phase={phase}
            docId={docId}
            taskId={taskId}
            errorDetail={errorDetail}
            onReset={resetForNewScan}
            onGoLibrary={() => navigate({ to: "/library" })}
            onGoInbox={() =>
              navigate({ to: "/library", search: { tab: "review" } })
            }
          />
        )}
      </main>

      {adjustTarget && (
        <CornerAdjusterModal
          blob={adjustTarget.blob}
          onCancel={() => setAdjustTargetId(null)}
          onApply={(warped) => {
            dispatch({ type: "replace", id: adjustTarget.id, blob: warped });
            setAdjustTargetId(null);
          }}
        />
      )}
    </div>
  );
}

type PageTileProps = {
  page: ScanPage;
  index: number;
  total: number;
  onRotate: () => void;
  onCrop: () => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
};

function PageTile({
  page,
  index,
  total,
  onRotate,
  onCrop,
  onRemove,
  onMoveUp,
  onMoveDown,
}: PageTileProps) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const next = URL.createObjectURL(page.blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [page.blob]);

  return (
    <li className="overflow-hidden rounded-lg border border-hairline bg-surface shadow-sm">
      <div className="relative aspect-[3/4] w-full overflow-hidden bg-canvas">
        {url && (
          <img
            src={url}
            alt={`Seite ${index + 1}`}
            className="h-full w-full object-cover transition-transform"
            style={{ transform: `rotate(${page.rotation}deg)` }}
          />
        )}
        <span className="absolute left-2 top-2 inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-full bg-ink/80 px-1.5 text-xs font-semibold text-on-inverse">
          {index + 1}
        </span>
      </div>
      <div className="flex items-center justify-between gap-1 border-t border-hairline px-1.5 py-1.5">
        <div className="flex items-center gap-0.5">
          <TileBtn
            onClick={onMoveUp}
            disabled={index === 0}
            label="Nach oben"
          >
            <ArrowUpIcon className="h-4 w-4" />
          </TileBtn>
          <TileBtn
            onClick={onMoveDown}
            disabled={index === total - 1}
            label="Nach unten"
          >
            <ArrowDownIcon className="h-4 w-4" />
          </TileBtn>
        </div>
        <div className="flex items-center gap-0.5">
          <TileBtn onClick={onRotate} label="Drehen">
            <RotateIcon className="h-4 w-4" />
          </TileBtn>
          <TileBtn onClick={onCrop} label="Ecken anpassen">
            <CropIcon className="h-4 w-4" />
          </TileBtn>
          <TileBtn onClick={onRemove} label="Löschen" danger>
            <TrashIcon className="h-4 w-4" />
          </TileBtn>
        </div>
      </div>
    </li>
  );
}

type TileBtnProps = {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  danger?: boolean;
  children: React.ReactNode;
};

function TileBtn({ onClick, disabled, label, danger, children }: TileBtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-30 ${
        danger ? "text-red-700 hover:bg-red-50" : "text-ink-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

type TerminalSummaryProps = {
  phase: Phase;
  docId: number | null;
  taskId: string | null;
  errorDetail: string | null;
  onReset: () => void;
  onGoLibrary: () => void;
  onGoInbox: () => void;
};

function TerminalSummary({
  phase,
  docId,
  errorDetail,
  onReset,
  onGoLibrary,
  onGoInbox,
}: TerminalSummaryProps) {
  return (
    <div className="mt-6 rounded-xl border border-hairline bg-surface p-5">
      <div className={`text-sm font-medium ${PHASE_COPY[phase].tone}`}>
        {PHASE_COPY[phase].label}
      </div>
      {docId !== null && (
        <div className="mt-1 text-xs text-ink-subtle">
          Dokument{" "}
          <Link
            to="/library/$id"
            params={{ id: String(docId) }}
            className="font-medium underline hover:text-ink"
          >
            #{docId}
          </Link>
        </div>
      )}
      {errorDetail && (
        <div className="mt-2 text-sm text-red-700">{errorDetail}</div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onReset}
          className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-on-inverse hover:opacity-80"
        >
          Weiteres Dokument scannen
        </button>
        {phase === "inbox" && (
          <button
            type="button"
            onClick={onGoInbox}
            className="rounded-md border border-hairline bg-surface px-3 py-2 text-sm font-medium text-ink-muted hover:bg-canvas"
          >
            Zur Prüfung →
          </button>
        )}
        {phase === "library" && (
          <button
            type="button"
            onClick={onGoLibrary}
            className="rounded-md border border-hairline bg-surface px-3 py-2 text-sm font-medium text-ink-muted hover:bg-canvas"
          >
            Zur Bibliothek →
          </button>
        )}
      </div>
    </div>
  );
}
