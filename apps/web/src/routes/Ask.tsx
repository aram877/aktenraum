import { useState } from "react";

import { DocumentCard } from "../components/DocumentCard";
import { Nav } from "../components/Nav";
import type { AnswerResponse } from "../lib/ai";
import { useAsk } from "../lib/ai";

export function Ask() {
  const askMutation = useAsk();
  const [question, setQuestion] = useState("");

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim()) return;
    await askMutation.mutateAsync(question.trim()).catch(() => {});
  };

  const errorDetail =
    askMutation.error?.response?.data?.detail ?? askMutation.error?.message ?? null;

  return (
    <div className="flex min-h-full flex-col">
      <Nav active="ask" />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
        <h1 className="text-lg font-semibold tracking-tight">Ask AI</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Stelle eine Frage — z.B. „Wann muss ich meinen Personalausweis verlängern?“
        </p>

        <form onSubmit={onSubmit} className="mt-4 flex gap-2">
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Was möchtest du wissen?"
            className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none"
          />
          <button
            type="submit"
            disabled={askMutation.isPending || !question.trim()}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60"
          >
            {askMutation.isPending ? "…" : "Fragen"}
          </button>
        </form>

        {errorDetail && (
          <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorDetail}
          </p>
        )}

        {askMutation.isPending && <LoadingCard />}

        {askMutation.data && !askMutation.isPending && (
          <AnswerPanel data={askMutation.data} />
        )}
      </main>
    </div>
  );
}

function LoadingCard() {
  return (
    <section className="mt-6 space-y-4" aria-busy="true" aria-live="polite">
      <div className="rounded-md border border-neutral-200 bg-white p-4">
        <div className="flex items-center gap-3 text-sm text-neutral-700">
          <Spinner />
          <span className="font-medium">Denke nach…</span>
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          Frage wird analysiert, passende Dokumente werden gesucht und eine
          Antwort formuliert. Bei lokalen Modellen kann das bis zu 30 Sekunden
          dauern.
        </p>
        <div className="mt-4 space-y-2">
          <div className="h-3 w-11/12 animate-pulse rounded bg-neutral-200" />
          <div className="h-3 w-9/12 animate-pulse rounded bg-neutral-200" />
          <div className="h-3 w-10/12 animate-pulse rounded bg-neutral-200" />
        </div>
      </div>
    </section>
  );
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin text-neutral-500"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        className="opacity-25"
      />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AnswerPanel({ data }: { data: AnswerResponse }) {
  return (
    <section className="mt-6 space-y-4">
      <div className="rounded-md border border-neutral-200 bg-white p-4">
        <p className="text-sm leading-relaxed text-neutral-900">{data.answer_de}</p>
      </div>

      {data.citations.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            {data.citations.length === 1 ? "Quelle" : "Quellen"}
          </h2>
          <div className="space-y-2">
            {data.citations.map((doc, idx) => (
              <DocumentCard
                key={doc.id}
                doc={doc}
                citationLabel={`Q${idx + 1}`}
              />
            ))}
          </div>
        </div>
      )}

      {data.total > data.citations.length && (
        <p className="text-xs text-neutral-500">
          {data.total} weitere Treffer ohne direkten Bezug zur Frage. Probiere die{" "}
          <a className="underline" href="/find">
            Dokumentensuche
          </a>
          , um sie zu sehen.
        </p>
      )}
    </section>
  );
}
