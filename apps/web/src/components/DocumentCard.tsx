import { useState } from "react";

import type { DocumentSummary } from "../lib/ai";
import { DocumentPreviewModal } from "./DocumentPreviewModal";
import { ProcessingBadge } from "./ProcessingBadge";

type Props = {
  doc: DocumentSummary;
  citationLabel?: string | null;
};

export function DocumentCard({ doc, citationLabel }: Props) {
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <article className="rounded-md border border-neutral-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {citationLabel && (
            <span className="mb-1 inline-block rounded-full bg-neutral-900 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
              {citationLabel}
            </span>
          )}
          <h3 className="truncate text-sm font-semibold text-neutral-900">
            {doc.title}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
            {doc.document_type && (
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-neutral-700">
                {doc.document_type}
              </span>
            )}
            {doc.correspondent && <span>{doc.correspondent}</span>}
            {doc.created && <span>{doc.created}</span>}
            <ProcessingBadge tags={doc.lifecycle_tags ?? []} />
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1 text-xs font-medium text-neutral-900 hover:bg-neutral-100"
          >
            Öffnen
          </button>
          <a
            href={`/api/documents/${doc.id}/download`}
            className="rounded-md bg-neutral-900 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-800"
          >
            Download
          </a>
        </div>
      </div>
      {previewOpen && (
        <DocumentPreviewModal doc={doc} onClose={() => setPreviewOpen(false)} />
      )}
    </article>
  );
}
