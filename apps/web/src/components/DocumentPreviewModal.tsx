import { useEffect, useState } from "react";

import type { DocumentSummary } from "../lib/ai";
import { useDeleteDocument, useDismissDuplicate, useReprocess } from "../lib/documents";

type Props = {
  doc: DocumentSummary;
  onClose: () => void;
  /** Hide the Reprocess button — used on the inbox review page where the doc
   *  is already in flight. */
  showReprocess?: boolean;
  /** Hide the Delete button — opt out where deletion isn't appropriate
   *  (e.g. a citation card in /ask). Default true. */
  showDelete?: boolean;
};

export function DocumentPreviewModal({
  doc,
  onClose,
  showReprocess = true,
  showDelete = true,
}: Props) {
  const reprocess = useReprocess();
  const deleteDoc = useDeleteDocument();
  const dismissDuplicate = useDismissDuplicate();
  const [confirming, setConfirming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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

  const onDelete = async () => {
    try {
      await deleteDoc.mutateAsync(doc.id);
      onClose();
    } catch {
      // surfaced via deleteError below
    }
  };

  const reprocessError = reprocess.error?.response?.data?.detail
    ?? reprocess.error?.message
    ?? null;
  const deleteError = deleteDoc.error?.response?.data?.detail
    ?? deleteDoc.error?.message
    ?? null;
  const dismissError = dismissDuplicate.error?.response?.data?.detail
    ?? dismissDuplicate.error?.message
    ?? null;
  const isDuplicate =
    !dismissDuplicate.isSuccess && doc.lifecycle_tags.includes("ai-duplicate");

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 sm:px-4 sm:py-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full flex-col overflow-hidden bg-white shadow-xl sm:max-w-5xl sm:rounded-lg"
      >
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-200 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{doc.title}</div>
            {doc.original_file_name && doc.original_file_name !== doc.title && (
              <div className="truncate text-[11px] text-neutral-400">
                Original: {doc.original_file_name}
              </div>
            )}
            <div className="text-xs text-neutral-500">
              {doc.document_type ?? "—"}
              {doc.correspondent ? ` · ${doc.correspondent}` : ""}
              {doc.created ? ` · ${doc.created}` : ""}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
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
            {showDelete && !confirmingDelete && (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                disabled={deleteDoc.isPending}
                className="rounded-md border border-red-300 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                title="In den Papierkorb verschieben (30 Tage wiederherstellbar)"
              >
                Löschen
              </button>
            )}
            {showDelete && confirmingDelete && (
              <div className="flex items-center gap-1 rounded-md border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-900">
                <span>In den Papierkorb verschieben?</span>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deleteDoc.isPending}
                  className="rounded px-2 py-0.5 hover:bg-red-100"
                >
                  Abbrechen
                </button>
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={deleteDoc.isPending}
                  className="rounded bg-red-600 px-2 py-0.5 font-medium text-white hover:bg-red-700 disabled:opacity-60"
                >
                  {deleteDoc.isPending ? "…" : "Ja, in Papierkorb"}
                </button>
              </div>
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
        {(reprocessError || deleteError || dismissError) && (
          <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
            {reprocessError ?? deleteError ?? dismissError}
          </div>
        )}
        {isDuplicate && (
          <div className="flex items-center justify-between border-b border-amber-200 bg-amber-50 px-4 py-2">
            <span className="text-xs text-amber-800">
              Mögliches Duplikat erkannt — dieses Dokument ähnelt einem anderen im Archiv.
            </span>
            <button
              type="button"
              onClick={() => dismissDuplicate.mutate(doc.id)}
              disabled={dismissDuplicate.isPending}
              className="ml-4 shrink-0 rounded-md border border-amber-300 bg-white px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
            >
              {dismissDuplicate.isPending ? "…" : "Markierung entfernen"}
            </button>
          </div>
        )}
        {dismissDuplicate.isSuccess && (
          <div className="border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-700">
            ✓ Duplikat-Markierung entfernt
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
