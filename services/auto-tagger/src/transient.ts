const TRANSIENT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

function statusOf(error: Error): number | undefined {
  const candidate = error as Error & { status?: unknown; status_code?: unknown };
  const raw = candidate.status ?? candidate.status_code;
  return typeof raw === "number" ? raw : undefined;
}

export function isTransientLlmError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause !== error && isTransientLlmError(cause)) return true;
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) return true;
  if (error.constructor.name === "APIConnectionError" || error.constructor.name === "APIConnectionTimeoutError") {
    return true;
  }
  const status = statusOf(error);
  return status !== undefined && (status === 429 || status >= 500);
}

export class TransientFailureTracker {
  private readonly counts = new Map<number, number>();

  constructor(readonly maxAttempts = 3) {}

  record(docId: number): number {
    const next = (this.counts.get(docId) ?? 0) + 1;
    this.counts.set(docId, next);
    return next;
  }

  clear(docId: number): void {
    this.counts.delete(docId);
  }
}
