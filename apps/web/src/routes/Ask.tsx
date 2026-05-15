import { useCallback, useEffect, useRef, useState } from "react";

import { DocumentCard } from "../components/DocumentCard";
import { Nav } from "../components/Nav";
import type { DocumentSummary, StreamMeta } from "../lib/ai";
import { streamAsk } from "../lib/ai";

type StreamPhase = "idle" | "streaming" | "done" | "error";

type StreamState = {
  phase: StreamPhase;
  meta: StreamMeta | null;
  text: string;
  citations: DocumentSummary[];
  total: number;
  errorDetail: string | null;
};

const INITIAL_STATE: StreamState = {
  phase: "idle",
  meta: null,
  text: "",
  citations: [],
  total: 0,
  errorDetail: null,
};

export function Ask() {
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<StreamState>(INITIAL_STATE);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = question.trim();
      if (!trimmed) return;
      controllerRef.current?.abort();
      setState({
        phase: "streaming",
        meta: null,
        text: "",
        citations: [],
        total: 0,
        errorDetail: null,
      });
      controllerRef.current = streamAsk(trimmed, {
        onMeta: (meta) => {
          setState((s) => ({ ...s, meta, total: meta.total }));
        },
        onChunk: (delta) => {
          setState((s) => ({ ...s, text: s.text + delta }));
        },
        onFinal: (final) => {
          setState((s) => ({
            ...s,
            phase: "done",
            text: final.answer_de,
            citations: final.citations,
            total: final.total,
          }));
        },
        onError: (detail) => {
          setState((s) => ({ ...s, phase: "error", errorDetail: detail }));
        },
      });
    },
    [question],
  );

  const isStreaming = state.phase === "streaming";

  return (
    <div className="flex min-h-full flex-col">
      <Nav active="ask" />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
        <h1 className="text-lg font-semibold tracking-tight text-ink">Ask AI</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Stelle eine Frage — z.B. „Wann muss ich meinen Personalausweis verlängern?"
        </p>

        <form onSubmit={onSubmit} className="mt-5 flex gap-2">
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Was möchtest du wissen?"
            className="flex-1 rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={isStreaming || !question.trim()}
            className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-on-inverse hover:opacity-80 disabled:opacity-50"
          >
            {isStreaming ? "…" : "Fragen"}
          </button>
        </form>

        {state.phase === "error" && state.errorDetail && (
          <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {state.errorDetail}
          </p>
        )}

        {(isStreaming || state.phase === "done") && (
          <AnswerPanel state={state} streaming={isStreaming} />
        )}
      </main>
    </div>
  );
}

function AnswerPanel({
  state,
  streaming,
}: {
  state: StreamState;
  streaming: boolean;
}) {
  return (
    <section className="mt-6 space-y-4" aria-busy={streaming} aria-live="polite">
      <div className="rounded-lg border border-hairline bg-surface p-5">
        {streaming && state.text === "" ? (
          <div className="flex items-center gap-3 text-sm text-ink-muted">
            <Spinner />
            <span className="font-medium">Denke nach…</span>
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <p className="flex-1 whitespace-pre-wrap text-sm leading-relaxed text-ink">
              {stripCitationMarkers(state.text)}
              {streaming && <Cursor />}
            </p>
            {streaming && state.text !== "" && (
              <Spinner className="mt-1 shrink-0" />
            )}
          </div>
        )}
      </div>

      {state.citations.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
            {state.citations.length === 1 ? "Quelle" : "Quellen"}
          </h2>
          <div className="space-y-2">
            {state.citations.map((doc, idx) => (
              <DocumentCard
                key={doc.id}
                doc={doc}
                citationLabel={`Q${idx + 1}`}
              />
            ))}
          </div>
        </div>
      )}

      {state.phase === "done" && state.total > state.citations.length && (
        <p className="text-xs text-ink-subtle">
          {state.total} weitere Treffer ohne direkten Bezug zur Frage. Probiere die{" "}
          <a className="text-ink-muted underline hover:text-ink" href="/find">
            Dokumentensuche
          </a>
          , um sie zu sehen.
        </p>
      )}
    </section>
  );
}

function stripCitationMarkers(text: string): string {
  return text.replace(/\s*\[Quelle:\s*\d+\s*\]/gi, "");
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={`h-4 w-4 animate-spin text-ink-subtle ${className ?? ""}`}
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

function Cursor() {
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-ink-faint align-middle"
    />
  );
}
