/**
 * Reads a document's home space from aktenraum-api (ADR-009) for the RAG
 * payload and for keeping corpus features — few-shot examples, the
 * correspondent history hint, duplicate detection — inside that space.
 */

export interface DocumentSpace {
  spaceId: number;
  sharedWith: readonly number[];
  /** Every document of the same home space, including this one. */
  peers: ReadonlySet<number>;
}

/** null = the document has no home space yet. Throws when the api can't answer. */
export type SpaceLookup = (docId: number) => Promise<DocumentSpace | null>;

export function apiSpaceLookup(
  apiUrl: string,
  serviceToken: string,
  fetchFn: typeof fetch = fetch,
): SpaceLookup {
  return async (docId) => {
    const headers: Record<string, string> = {};
    if (serviceToken) headers.Authorization = `Bearer ${serviceToken}`;
    const resp = await fetchFn(
      `${apiUrl.replace(/\/+$/, "")}/api/tenancy/documents/${docId}/space`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    if (!resp.ok) {
      throw Object.assign(
        new Error(`document space ${resp.status}: ${(await resp.text()).slice(0, 200)}`),
        { status: resp.status },
      );
    }
    const body = (await resp.json()) as {
      space_id?: number | null;
      shared_with?: number[];
      space_document_ids?: number[];
    };
    if (typeof body.space_id !== "number") return null;
    return {
      spaceId: body.space_id,
      sharedWith: Array.isArray(body.shared_with) ? body.shared_with : [],
      peers: new Set(Array.isArray(body.space_document_ids) ? body.space_document_ids : []),
    };
  };
}

/**
 * The set of documents corpus features may draw on for `docId`, or null when
 * they must be skipped: no home space yet, or the api didn't answer. Without a
 * lookup configured (no api URL) features stay unscoped — `undefined`.
 */
export async function corpusScope(
  lookup: SpaceLookup | undefined,
  docId: number,
  onSkip: (reason: string) => void,
): Promise<ReadonlySet<number> | null | undefined> {
  if (lookup === undefined) return undefined;
  try {
    const space = await lookup(docId);
    if (space === null) {
      onSkip("no_home_space");
      return null;
    }
    return space.peers;
  } catch (error: unknown) {
    onSkip(error instanceof Error ? error.message : String(error));
    return null;
  }
}
