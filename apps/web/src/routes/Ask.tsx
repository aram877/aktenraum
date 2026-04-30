import { useState } from "react";

import { FilterChips } from "../components/FilterChips";
import { Nav } from "../components/Nav";
import type { AskResponse, DocumentSummary, SearchFilter } from "../lib/ai";
import { useAsk } from "../lib/ai";

export function Ask() {
  const askMutation = useAsk();
  const [query, setQuery] = useState("");

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    await askMutation.mutateAsync({ query: query.trim() }).catch(() => {});
  };

  const onClearChip = async (key: keyof SearchFilter) => {
    const current = askMutation.data?.filter;
    if (!current) return;
    const next: SearchFilter = { ...current, [key]: null };
    await askMutation.mutateAsync({ filter: next }).catch(() => {});
  };

  const errorDetail =
    askMutation.error?.response?.data?.detail ?? askMutation.error?.message ?? null;

  return (
    <div className="flex min-h-full flex-col">
      <Nav active="ask" />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
        <h1 className="text-lg font-semibold tracking-tight">Ask AI</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Frag in Alltagssprache — z.B. „Lohnabrechnungen aus 2023 über 3000€“.
        </p>

        <form onSubmit={onSubmit} className="mt-4 flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Was suchst du?"
            className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none"
          />
          <button
            type="submit"
            disabled={askMutation.isPending || !query.trim()}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60"
          >
            {askMutation.isPending ? "…" : "Suchen"}
          </button>
        </form>

        {errorDetail && (
          <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorDetail}
          </p>
        )}

        {askMutation.data && (
          <ResultsPanel
            data={askMutation.data}
            onClearChip={onClearChip}
            disabled={askMutation.isPending}
          />
        )}
      </main>
    </div>
  );
}

function ResultsPanel({
  data,
  onClearChip,
  disabled,
}: {
  data: AskResponse;
  onClearChip: (key: keyof SearchFilter) => void;
  disabled: boolean;
}) {
  return (
    <section className="mt-6 space-y-4">
      <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
        {data.explanation}
      </div>

      <FilterChips filter={data.filter} onClear={onClearChip} disabled={disabled} />

      <div className="text-xs text-neutral-500">
        {data.total === 0
          ? "Keine Treffer."
          : `${data.total} Treffer${
              data.total !== data.results.length
                ? ` (zeige ${data.results.length})`
                : ""
            }`}
      </div>

      <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 bg-white">
        {data.results.map((r) => (
          <ResultRow key={r.id} doc={r} />
        ))}
      </ul>
    </section>
  );
}

function ResultRow({ doc }: { doc: DocumentSummary }) {
  return (
    <li className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-neutral-900">
          {doc.title}
        </div>
        <div className="mt-1 flex flex-wrap gap-2 text-xs text-neutral-500">
          {doc.document_type && (
            <span className="rounded-full bg-neutral-100 px-2 py-0.5">
              {doc.document_type}
            </span>
          )}
          {doc.correspondent && <span>{doc.correspondent}</span>}
          {doc.created && <span>{doc.created}</span>}
          {doc.monetary_amount && <span>{doc.monetary_amount}</span>}
        </div>
      </div>
    </li>
  );
}
