export interface DocumentSummary {
  id: number;
  title: string;
  original_file_name: string | null;
  correspondent: string | null;
  document_type: string | null;
  created: string | null;
  lifecycle_tags: string[];
  tags: string[];
  ai_error_message: string | null;
}

export interface StreamMeta {
  filter: Record<string, unknown>;
  explanation: string;
  total: number;
}

export interface StreamFinal {
  answer_de: string;
  citations: DocumentSummary[];
  total: number;
}

export interface StreamHandlers {
  onMeta?: (meta: StreamMeta) => void;
  onChunk?: (delta: string) => void;
  onFinal?: (final: StreamFinal) => void;
  onError?: (detail: string) => void;
}

export function dispatchSseRecord(record: string, handlers: StreamHandlers): void {
  let event = "message";
  let data = "";
  for (const line of record.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data += (data ? "\n" : "") + line.slice(5).trim();
    }
  }
  if (!data) return;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return;
  }
  switch (event) {
    case "meta":
      handlers.onMeta?.(payload as StreamMeta);
      break;
    case "chunk":
      handlers.onChunk?.((payload as { text: string }).text);
      break;
    case "final":
      handlers.onFinal?.(payload as StreamFinal);
      break;
    case "error":
      handlers.onError?.((payload as { detail: string }).detail);
      break;
  }
}

export function extractErrorDetail(body: string, fallback: string): string {
  if (!body) return fallback;
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === "string" && parsed.detail.trim()) return parsed.detail;
  } catch {
    if (body.trim().length <= 500) return body.trim();
    return fallback;
  }
  if (body.trim().length <= 500) return body.trim();
  return fallback;
}

export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  handlers: StreamHandlers,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      dispatchSseRecord(buffer.slice(0, idx), handlers);
      buffer = buffer.slice(idx + 2);
      idx = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim().length > 0) dispatchSseRecord(buffer, handlers);
}
