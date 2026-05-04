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

  // Cancel any in-flight stream on unmount so we don't keep the LLM running
  // for a page the user has already navigated away from.
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
      // Cancel any prior stream before starting a new one — a fast user
      // hitting "Fragen" twice would otherwise see two streams interleave.
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
            // Replace accumulated text with the canonical final value —
            // the backend may have substituted a soft-fail message after
            // detecting a degenerate answer.
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
            disabled={isStreaming || !question.trim()}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60"
          >
            {isStreaming ? "…" : "Fragen"}
          </button>
        </form>

        {state.phase === "error" && state.errorDetail && (
          <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
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
      <div className="rounded-md border border-neutral-200 bg-white p-4">
        {streaming && state.text === "" ? (
          // Pre-first-chunk: show the spinner + heads-up so the user sees
          // *something* during the filter+retrieval round-trip, before the
          // model starts emitting tokens. Most of the latency lives here on
          // local LLMs.
          <div className="flex items-center gap-3 text-sm text-neutral-700">
            <Spinner />
            <span className="font-medium">Denke nach…</span>
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <p className="flex-1 whitespace-pre-wrap text-sm leading-relaxed text-neutral-900">
              {/* Strip the inline [Quelle: N] markers so they don't clutter
                  the reading flow — the citation cards below already attribute
                  each fact to a doc. */}
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
          <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
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

      {state.phase === "done" &&
        state.total > state.citations.length && (
          <p className="text-xs text-neutral-500">
            {state.total} weitere Treffer ohne direkten Bezug zur Frage. Probiere die{" "}
            <a className="underline" href="/find">
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
      className={`h-4 w-4 animate-spin text-neutral-500 ${className ?? ""}`}
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
  // Blinking caret to make the streaming text feel alive. Pure-CSS via
  // tailwind's animate-pulse on a thin span.
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-neutral-400 align-middle"
    />
  );
}
