import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { Nav } from "../components/Nav";
import type { InboxItem } from "../lib/inbox";
import { useBulkApprove, useInboxList } from "../lib/inbox";

export function Inbox() {
  const list = useInboxList({ pageSize: 50 });
  const navigate = useNavigate();
  const bulkApprove = useBulkApprove();

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [lastResult, setLastResult] = useState<{
    succeeded: number;
    failed: number;
  } | null>(null);

  const visibleIds = useMemo(
    () => list.data?.results.map((r) => r.id) ?? [],
    [list.data],
  );

  // Drop selections for rows no longer in the list (e.g. after refetch following approval).
  const effectiveSelected = useMemo(() => {
    if (!visibleIds.length) return selected;
    const visible = new Set(visibleIds);
    let pruned = false;
    const next = new Set<number>();
    selected.forEach((id) => {
      if (visible.has(id)) next.add(id);
      else pruned = true;
    });
    return pruned ? next : selected;
  }, [selected, visibleIds]);

  const selectedCount = effectiveSelected.size;
  const allSelected =
    visibleIds.length > 0 && visibleIds.every((id) => effectiveSelected.has(id));

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(visibleIds));
    }
  };

  const onBulkApprove = async () => {
    const ids = Array.from(effectiveSelected);
    if (ids.length === 0) return;
    setLastResult(null);
    const res = await bulkApprove.mutateAsync(ids);
    setLastResult({ succeeded: res.succeeded.length, failed: res.failed.length });
    setSelected((prev) => {
      const next = new Set(prev);
      res.succeeded.forEach((id) => next.delete(id));
      return next;
    });
  };

  return (
    <div className="flex min-h-full flex-col">
      <Nav active="inbox" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold tracking-tight">Inbox</h1>
          <span className="text-sm text-neutral-500">
            {list.data ? `${list.data.total} offen` : "…"}
          </span>
        </div>
        <p className="mt-1 text-sm text-neutral-600">
          Dokumente warten auf Prüfung. Klicke auf eine Zeile, um sie zu öffnen.
        </p>

        {list.isError && (
          <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            Konnte die Inbox nicht laden.
          </p>
        )}

        {list.data && list.data.results.length === 0 && (
          <div className="mt-8 rounded-md border border-dashed border-neutral-300 bg-white p-8 text-center text-sm text-neutral-600">
            Keine offenen Dokumente.{" "}
            <Link to="/ask" className="font-medium text-neutral-900 underline">
              Suche stattdessen.
            </Link>
          </div>
        )}

        {list.data && list.data.results.length > 0 && (
          <>
            {selectedCount > 0 && (
              <div className="sticky top-0 z-10 mt-6 flex flex-wrap items-center justify-between gap-3 rounded-md border border-neutral-300 bg-neutral-900 px-4 py-2 text-sm text-white">
                <span>
                  {selectedCount}{" "}
                  {selectedCount === 1 ? "Dokument ausgewählt" : "Dokumente ausgewählt"}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSelected(new Set())}
                    disabled={bulkApprove.isPending}
                    className="rounded-md border border-neutral-600 px-3 py-1 text-xs text-neutral-100 hover:bg-neutral-800 disabled:opacity-60"
                  >
                    Auswahl aufheben
                  </button>
                  <button
                    type="button"
                    onClick={onBulkApprove}
                    disabled={bulkApprove.isPending}
                    className="rounded-md bg-white px-3 py-1 text-xs font-medium text-neutral-900 hover:bg-neutral-100 disabled:opacity-60"
                  >
                    {bulkApprove.isPending
                      ? "Genehmige…"
                      : `${selectedCount} genehmigen`}
                  </button>
                </div>
              </div>
            )}

            {lastResult && (
              <p
                className={`mt-4 rounded-md border px-3 py-2 text-sm ${
                  lastResult.failed
                    ? "border-amber-300 bg-amber-50 text-amber-900"
                    : "border-emerald-300 bg-emerald-50 text-emerald-900"
                }`}
              >
                {lastResult.succeeded} genehmigt
                {lastResult.failed ? ` · ${lastResult.failed} fehlgeschlagen` : ""}.
              </p>
            )}

            <table className="mt-6 w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="w-8 px-2 py-2">
                    <input
                      type="checkbox"
                      aria-label="Alle auswählen"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="h-4 w-4 cursor-pointer accent-neutral-900"
                    />
                  </th>
                  <th className="px-2 py-2">Titel</th>
                  <th className="px-2 py-2">Typ</th>
                  <th className="px-2 py-2">Korrespondent</th>
                  <th className="px-2 py-2">Datum</th>
                  <th className="px-2 py-2 text-right">Konfidenz</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200">
                {list.data.results.map((row) => (
                  <Row
                    key={row.id}
                    row={row}
                    checked={effectiveSelected.has(row.id)}
                    onToggle={() => toggleOne(row.id)}
                    onOpen={() =>
                      navigate({ to: "/inbox/$id", params: { id: String(row.id) } })
                    }
                  />
                ))}
              </tbody>
            </table>
          </>
        )}
      </main>
    </div>
  );
}

function Row({
  row,
  checked,
  onToggle,
  onOpen,
}: {
  row: InboxItem;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const baseCls = "hover:bg-neutral-50";
  const flagCls = row.low_confidence ? "border-l-4 border-amber-400" : "";
  return (
    <tr className={`${baseCls} ${flagCls}`}>
      <td className="w-8 px-2 py-2" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          aria-label={`${row.title} auswählen`}
          checked={checked}
          onChange={onToggle}
          className="h-4 w-4 cursor-pointer accent-neutral-900"
        />
      </td>
      <td
        onClick={onOpen}
        className="cursor-pointer px-2 py-2 font-medium text-neutral-900"
      >
        {row.title}
      </td>
      <td onClick={onOpen} className="cursor-pointer px-2 py-2 text-neutral-700">
        {row.ai_document_type ?? "—"}
      </td>
      <td onClick={onOpen} className="cursor-pointer px-2 py-2 text-neutral-700">
        {row.ai_correspondent ?? "—"}
      </td>
      <td onClick={onOpen} className="cursor-pointer px-2 py-2 text-neutral-700">
        {row.ai_issue_date ?? row.created ?? "—"}
      </td>
      <td
        onClick={onOpen}
        className="cursor-pointer px-2 py-2 text-right text-neutral-700"
      >
        {row.ai_confidence != null
          ? `${Math.round(row.ai_confidence * 100)}%`
          : "—"}
      </td>
    </tr>
  );
}
