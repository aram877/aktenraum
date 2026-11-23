const STREAM_CUT_DE =
  "Die Verbindung wurde unterbrochen, bevor die Antwort vollständig war. Bitte erneut fragen.";

export type AskPhase = "searching" | "answering" | "done";

export function useAnswerStream() {
  const answer = ref("");
  const meta = ref<StreamMeta | null>(null);
  const sources = ref<readonly DocumentSummary[]>([]);
  const citations = ref<readonly DocumentSummary[]>([]);
  const phase = ref<AskPhase>("done");
  const errorText = ref<string | null>(null);
  const streaming = ref(false);
  let controller: AbortController | null = null;

  onBeforeUnmount(() => controller?.abort());

  const handlers: StreamHandlers = {
    onMeta: (next) => {
      meta.value = next;
    },
    onSources: (next) => {
      sources.value = next.sources;
      if (meta.value) meta.value = { ...meta.value, total: next.total };
      phase.value = "answering";
    },
    onChunk: (delta) => {
      answer.value += delta;
    },
    onFinal: (final) => {
      answer.value = final.answer_de;
      citations.value = final.citations;
      streaming.value = false;
      phase.value = "done";
    },
    onError: (detail) => {
      errorText.value = detail;
      streaming.value = false;
      phase.value = "done";
    },
  };

  async function run(question: string, signal: AbortSignal): Promise<void> {
    try {
      const resp = await fetch("/api/ai/answer/stream", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal,
      });
      if (!resp.ok || !resp.body) {
        const body = await resp.text().catch(() => "");
        handlers.onError?.(extractErrorDetail(body, `${resp.status} ${resp.statusText}`));
        return;
      }
      await readSseStream(resp.body, handlers);
      if (streaming.value && !signal.aborted) handlers.onError?.(STREAM_CUT_DE);
    } catch (error: unknown) {
      if (signal.aborted) return;
      handlers.onError?.(error instanceof Error ? error.message : String(error));
    }
  }

  function ask(question: string): void {
    const q = question.trim();
    if (!q || streaming.value) return;
    controller?.abort();
    answer.value = "";
    meta.value = null;
    sources.value = [];
    citations.value = [];
    errorText.value = null;
    streaming.value = true;
    phase.value = "searching";
    controller = new AbortController();
    void run(q, controller.signal);
  }

  function stop(): void {
    controller?.abort();
    streaming.value = false;
    phase.value = "done";
  }

  return { answer, meta, sources, citations, phase, errorText, streaming, ask, stop };
}
