import { useEffect, useState } from "react";

import type { DocumentSummary } from "../lib/ai";
import { useReprocess } from "../lib/documents";

type Props = {
  doc: DocumentSummary;
  onClose: () => void;
  /** Hide the Reprocess button — used on the inbox review page where the doc
   *  is already in flight. */
  showReprocess?: boolean;
};

export function DocumentPreviewModal({
  doc,
  onClose,
  showReprocess = true,
}: Props) {
  const reprocess = useReprocess();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const onReprocess = async () => {
    try {
      await reprocess.mutateAsync(doc.id);
    } catch {
      // surfaced via reprocess.error below
    }
  };

  const reprocessError = reprocess.error?.response?.data?.detail
    ?? reprocess.error?.message
    ?? null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-white shadow-xl"
      >
        <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{doc.title}</div>
            <div className="text-xs text-neutral-500">
              {doc.document_type ?? "—"}
              {doc.correspondent ? ` · ${doc.correspondent}` : ""}
              {doc.created ? ` · ${doc.created}` : ""}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {showReprocess && !reprocess.isSuccess && !confirming && (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={reprocess.isPending}
                className="rounded-md border border-neutral-300 bg-white px-3 py-1 text-xs font-medium text-neutral-900 hover:bg-neutral-100 disabled:opacity-50"
                title="Lifecycle-Tags löschen, Auto-Tagger neu starten"
              >
                Erneut verarbeiten
              </button>
            )}
            {showReprocess && confirming && !reprocess.isSuccess && (
              <div className="flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900">
                <span>Sicher?</span>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={reprocess.isPending}
                  className="rounded px-2 py-0.5 hover:bg-amber-100"
                >
                  Abbrechen
                </button>
                <button
                  type="button"
                  onClick={onReprocess}
                  disabled={reprocess.isPending}
                  className="rounded bg-amber-600 px-2 py-0.5 font-medium text-white hover:bg-amber-700 disabled:opacity-60"
                >
                  {reprocess.isPending ? "…" : "Ja, neu verarbeiten"}
                </button>
              </div>
            )}
            {reprocess.isSuccess && (
              <span className="rounded-md bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-800">
                ✓ Zur Prüfung hinzugefügt
              </span>
            )}
            <a
              href={`/api/documents/${doc.id}/download`}
              className="rounded-md border border-neutral-300 bg-white px-3 py-1 text-xs font-medium text-neutral-900 hover:bg-neutral-100"
            >
              Download
            </a>
            <button
              type="button"
              onClick={onClose}
              aria-label="Schließen"
              className="rounded-md bg-neutral-900 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-800"
            >
              Schließen
            </button>
          </div>
        </header>
        {reprocessError && (
          <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
            {reprocessError}
          </div>
        )}
        <iframe
          title={`Vorschau ${doc.id}`}
          src={`/api/documents/${doc.id}/preview`}
          className="flex-1 border-0"
        />
      </div>
    </div>
  );
}
