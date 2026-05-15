import { useState } from "react";

import type { DocumentSummary } from "../lib/ai";
import { isInFlight, useProcessingState } from "../lib/documents";
import { DocumentPreviewModal } from "./DocumentPreviewModal";
import { ProcessingBadge } from "./ProcessingBadge";

type Props = {
  doc: DocumentSummary;
  citationLabel?: string | null;
};

export function DocumentCard({ doc, citationLabel }: Props) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const processing = useProcessingState();

  return (
    <article className="rounded-lg border border-hairline bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {citationLabel && (
            <span className="mb-1.5 inline-block rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-on-accent">
              {citationLabel}
            </span>
          )}
          <h3 className="truncate text-sm font-medium text-ink">
            {doc.title}
          </h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-subtle">
            {doc.document_type && (
              <span className="rounded-full border border-hairline bg-canvas px-2 py-0.5 text-ink-muted">
                {doc.document_type}
              </span>
            )}
            {doc.correspondent && <span>{doc.correspondent}</span>}
            {doc.created && <span>{doc.created}</span>}
            <ProcessingBadge
              tags={doc.lifecycle_tags ?? []}
              errorMessage={doc.ai_error_message}
              inFlight={isInFlight(doc.id, processing.data)}
            />
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className="rounded-md border border-hairline bg-surface px-3 py-1 text-xs font-medium text-ink-muted hover:bg-canvas hover:text-ink"
          >
            Öffnen
          </button>
          <a
            href={`/api/documents/${doc.id}/download`}
            className="rounded-md bg-ink px-3 py-1 text-xs font-medium text-on-inverse hover:opacity-80"
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
