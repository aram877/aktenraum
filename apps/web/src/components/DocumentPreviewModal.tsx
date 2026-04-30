import { useEffect } from "react";

import type { DocumentSummary } from "../lib/ai";

type Props = {
  doc: DocumentSummary;
  onClose: () => void;
};

export function DocumentPreviewModal({ doc, onClose }: Props) {
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
        <iframe
          title={`Vorschau ${doc.id}`}
          src={`/api/documents/${doc.id}/preview`}
          className="flex-1 border-0"
        />
      </div>
    </div>
  );
}
