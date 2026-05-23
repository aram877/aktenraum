import { Link } from "@tanstack/react-router";

import { useDuplicateCandidates } from "../lib/documents";

/**
 * Banner shown on the detail page when the current doc carries
 * `ai-duplicate`. Lists each suspected match as a clickable link so the
 * user can open it and compare before deciding whether to dismiss the
 * flag (via the "Kein Duplikat" button in DocumentMarkers) or delete the
 * duplicate.
 *
 * Re-runs the dedup detector on every mount via the backend's
 * `/duplicate-candidates` endpoint — so the list stays honest after
 * dismissals, edits, or trashing of one of the pair.
 */
export function DuplicateNotice({
  docId,
  enabled,
}: {
  docId: number;
  /** Render nothing when false — caller decides based on parent
   * lifecycle tags. Avoids burning the round-trip on every detail
   * view. */
  enabled: boolean;
}) {
  const candidates = useDuplicateCandidates(docId, enabled);
  if (!enabled) return null;
  if (candidates.isLoading) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        Lade Duplikat-Kandidaten…
      </div>
    );
  }
  const list = candidates.data?.candidates ?? [];
  if (list.length === 0) return null;

  return (
    <div className="rounded-md border border-purple-200 bg-purple-50 px-3 py-2 text-xs text-purple-900">
      <div className="font-semibold">Mögliches Duplikat von:</div>
      <ul className="mt-1 space-y-1">
        {list.map((c) => (
          <li key={c.id}>
            <Link
              to="/library/$id"
              params={{ id: String(c.id) }}
              className="inline-flex flex-wrap items-baseline gap-x-2 text-purple-900 underline hover:text-purple-700"
            >
              <span className="font-medium">#{c.id}</span>
              <span className="truncate">{c.title}</span>
              {c.created && (
                <span className="text-[11px] text-purple-700">
                  ({c.created})
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-1 text-[11px] text-purple-700">
        Wenn es kein Duplikat ist, oben „Kein Duplikat" klicken.
      </div>
    </div>
  );
}
