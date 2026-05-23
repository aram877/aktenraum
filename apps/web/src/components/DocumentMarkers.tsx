import { useEffect, useState } from "react";

import {
  IMPORTANT_TAG,
  useDismissDuplicate,
  useStarDocument,
  useUnstarDocument,
} from "../lib/documents";

/**
 * Star (Als wichtig markieren) + duplicate-dismiss controls.
 *
 * Used on both /inbox/$id and /library/$id so the user can flip these
 * flags from the same spot they do everything else (Approve / Reject /
 * Löschen / Erneut verarbeiten). The DocumentPreviewModal has its own
 * inline implementation because it predated this component — kept
 * separate to avoid churning a shipped surface.
 *
 * State is read from `tags` (the doc's full tag list) so the icon
 * reflects server truth on initial render; clicks update optimistically
 * and revert if the mutation fails.
 */
export function DocumentMarkers({
  docId,
  tags,
  className,
}: {
  docId: number;
  /** Full tag list on the doc — used to detect membership in `wichtig`
   * and `ai-duplicate`. */
  tags: readonly string[];
  className?: string;
}) {
  const starDoc = useStarDocument();
  const unstarDoc = useUnstarDocument();
  const dismissDup = useDismissDuplicate();

  // Re-sync local state whenever the parent re-fetches: a refetch can
  // flip the doc's tag list out from under us (e.g. another tab
  // starred it, or the server-side state changed after reprocess).
  const serverImportant = tags.includes(IMPORTANT_TAG);
  const [important, setImportant] = useState(serverImportant);
  useEffect(() => {
    setImportant(serverImportant);
  }, [serverImportant]);

  const showDuplicate =
    tags.includes("ai-duplicate") && !dismissDup.isSuccess;
  const starPending = starDoc.isPending || unstarDoc.isPending;

  const toggleStar = async () => {
    const next = !important;
    setImportant(next);
    try {
      if (next) await starDoc.mutateAsync(docId);
      else await unstarDoc.mutateAsync(docId);
    } catch {
      setImportant(!next);
    }
  };

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className ?? ""}`}>
      <button
        type="button"
        onClick={toggleStar}
        disabled={starPending}
        title={
          important
            ? "Wichtig-Markierung entfernen"
            : "Als wichtig markieren — wird in der Bibliothek vorne sortiert"
        }
        className={
          important
            ? "inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
            : "inline-flex items-center gap-1 rounded-md border border-hairline bg-surface px-2.5 py-1 text-xs font-medium text-ink-muted hover:bg-canvas disabled:opacity-50"
        }
      >
        <span aria-hidden>{important ? "★" : "☆"}</span>
        <span className="hidden sm:inline">
          {important ? "Wichtig" : "Als wichtig markieren"}
        </span>
      </button>
      {showDuplicate && (
        <button
          type="button"
          onClick={() => dismissDup.mutate(docId)}
          disabled={dismissDup.isPending}
          title="Markiert das Dokument als geprüft — bei zukünftigen Propagationen wird es nicht erneut als Duplikat geflaggt"
          className="inline-flex items-center gap-1 rounded-md border border-purple-300 bg-purple-50 px-2.5 py-1 text-xs font-medium text-purple-800 hover:bg-purple-100 disabled:opacity-50"
        >
          {dismissDup.isPending ? "…" : "Kein Duplikat"}
        </button>
      )}
    </div>
  );
}
