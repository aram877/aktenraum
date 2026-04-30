import { Link, useNavigate } from "@tanstack/react-router";

import { Nav } from "../components/Nav";
import type { InboxItem } from "../lib/inbox";
import { useInboxList } from "../lib/inbox";

export function Inbox() {
  const list = useInboxList({ pageSize: 50 });
  const navigate = useNavigate();

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
          <table className="mt-6 w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-2 py-2">Titel</th>
                <th className="px-2 py-2">Typ</th>
                <th className="px-2 py-2">Korrespondent</th>
                <th className="px-2 py-2">Datum</th>
                <th className="px-2 py-2">Betrag</th>
                <th className="px-2 py-2 text-right">Konfidenz</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200">
              {list.data.results.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  onClick={() => navigate({ to: "/inbox/$id", params: { id: String(row.id) } })}
                />
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}

function Row({ row, onClick }: { row: InboxItem; onClick: () => void }) {
  const baseCls = "cursor-pointer hover:bg-neutral-50";
  const flagCls = row.low_confidence ? "border-l-4 border-amber-400" : "";
  return (
    <tr onClick={onClick} className={`${baseCls} ${flagCls}`}>
      <td className="px-2 py-2 font-medium text-neutral-900">{row.title}</td>
      <td className="px-2 py-2 text-neutral-700">
        {row.ai_document_type ?? "—"}
      </td>
      <td className="px-2 py-2 text-neutral-700">
        {row.ai_correspondent ?? "—"}
      </td>
      <td className="px-2 py-2 text-neutral-700">
        {row.ai_issue_date ?? row.created ?? "—"}
      </td>
      <td className="px-2 py-2 text-neutral-700">
        {row.ai_monetary_amount ?? "—"}
      </td>
      <td className="px-2 py-2 text-right text-neutral-700">
        {row.ai_confidence != null
          ? `${Math.round(row.ai_confidence * 100)}%`
          : "—"}
      </td>
    </tr>
  );
}
