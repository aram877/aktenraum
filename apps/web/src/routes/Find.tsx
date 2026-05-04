import { useState } from "react";

import { DocumentCard } from "../components/DocumentCard";
import { FilterChips } from "../components/FilterChips";
import { Nav } from "../components/Nav";
import type { FindResponse, SearchFilter } from "../lib/ai";
import { useFind } from "../lib/ai";

export function Find() {
  const findMutation = useFind();
  const [query, setQuery] = useState("");

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    await findMutation.mutateAsync({ query: query.trim() }).catch(() => {});
  };

  const onClearScalar = async (key: keyof Omit<SearchFilter, "tags">) => {
    const current = findMutation.data?.filter;
    if (!current) return;
    const next: SearchFilter = { ...current, [key]: null };
    await findMutation.mutateAsync({ filter: next }).catch(() => {});
  };

  const onClearTag = async (tag: string) => {
    const current = findMutation.data?.filter;
    if (!current) return;
    const next: SearchFilter = {
      ...current,
      tags: (current.tags ?? []).filter((t) => t !== tag),
    };
    await findMutation.mutateAsync({ filter: next }).catch(() => {});
  };

  const errorDetail =
    findMutation.error?.response?.data?.detail ?? findMutation.error?.message ?? null;

  return (
    <div className="flex min-h-full flex-col">
      <Nav active="find" />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
        <h1 className="text-lg font-semibold tracking-tight">Dokumente finden</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Beschreibe, was du suchst — z.B. „Gehaltsabrechnungen letzte 12 Monate“.
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
            disabled={findMutation.isPending || !query.trim()}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60"
          >
            {findMutation.isPending ? "…" : "Suchen"}
          </button>
        </form>

        {errorDetail && (
          <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorDetail}
          </p>
        )}

        {findMutation.data && (
          <ResultsPanel
            data={findMutation.data}
            onClearScalar={onClearScalar}
            onClearTag={onClearTag}
            disabled={findMutation.isPending}
          />
        )}
      </main>
    </div>
  );
}

function ResultsPanel({
  data,
  onClearScalar,
  onClearTag,
  disabled,
}: {
  data: FindResponse;
  onClearScalar: (key: keyof Omit<SearchFilter, "tags">) => void;
  onClearTag: (tag: string) => void;
  disabled: boolean;
}) {
  return (
    <section className="mt-6 space-y-4">
      <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
        {data.explanation}
      </div>

      <FilterChips
        filter={data.filter}
        onClearScalar={onClearScalar}
        onClearTag={onClearTag}
        disabled={disabled}
      />

      <div className="text-xs text-neutral-500">
        {data.total === 0
          ? "Keine Treffer."
          : `${data.total} Treffer${
              data.total !== data.results.length
                ? ` (zeige ${data.results.length})`
                : ""
            }`}
      </div>

      <div className="space-y-2">
        {data.results.map((doc) => (
          <DocumentCard key={doc.id} doc={doc} />
        ))}
      </div>
    </section>
  );
}
