/**
 * Asks aktenraum-api to give a document its home space (ADR-009) before the
 * worker extracts it. The api picks the space (uploader's personal space or the
 * household admin's) and mirrors it into Paperless permissions; it's idempotent,
 * so a reprocessed document simply keeps its space.
 */

/** 409 from the api: an aktenraum upload that may have created this document is still running. */
export class HomeSpacePendingError extends Error {
  constructor(docId: number) {
    super(`home space for document ${docId} not decidable yet (upload still running)`);
    this.name = "HomeSpacePendingError";
  }
}

export type AssignHomeSpace = (docId: number) => Promise<void>;

export function apiHomeSpaceAssigner(
  apiUrl: string,
  webhookSecret: string,
  fetchFn: typeof fetch = fetch,
): AssignHomeSpace {
  return async (docId) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (webhookSecret) headers["X-Aktenraum-Secret"] = webhookSecret;
    const resp = await fetchFn(`${apiUrl.replace(/\/+$/, "")}/api/tenancy/assign-home-space`, {
      method: "POST",
      headers,
      body: JSON.stringify({ document_id: docId }),
      signal: AbortSignal.timeout(30_000),
    });
    if (resp.status === 409) throw new HomeSpacePendingError(docId);
    if (!resp.ok) {
      throw Object.assign(
        new Error(`assign-home-space ${resp.status}: ${(await resp.text()).slice(0, 200)}`),
        { status: resp.status },
      );
    }
  };
}
