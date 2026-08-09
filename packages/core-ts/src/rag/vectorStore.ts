/**
 * Qdrant wrapper for the RAG indexing and query paths.
 *
 * Thin façade over `@qdrant/js-client-rest`'s QdrantClient shaped to our
 * actual operations: ensure-collection, upsert chunks, delete by doc,
 * search with payload filters, and a health probe.
 *
 * Design choices carried over from the Python side:
 *
 * - Point IDs are deterministic UUID5s of (docId, chunkIndex). This gives
 *   idempotent upserts (re-indexing the same doc replaces, never
 *   duplicates) without imposing a chunks-per-doc cap.
 * - Payload schema is denormalised at upsert time — doc_type,
 *   correspondent, tags, created_date live inside each chunk's payload so
 *   query-time structural filters apply at the Qdrant layer instead of
 *   post-fetch.
 * - Indexed payload fields are configured at collection-creation time.
 * - Async-only.
 */
import { QdrantClient } from "@qdrant/js-client-rest";
import { v5 as uuidv5 } from "uuid";
import { logger } from "../log.js";
import type { Chunk } from "./chunker.js";
import { DENSE_DIM } from "./embedder.js";

// Default collection name. The desktop shell can override at construction
// time per tenant, but a single-user install never needs to know this.
export const DEFAULT_COLLECTION = "aktenraum_chunks";

// Stable namespace for deterministic chunk IDs. Copied verbatim from the
// Python side (`_POINT_ID_NAMESPACE`) — UUID5 is a well-defined,
// cross-language-deterministic algorithm (SHA-1 based per RFC 4122), so
// the same namespace + name string produces byte-identical UUIDs in both
// languages. This MUST stay identical so a Node re-index doesn't orphan
// (or duplicate) points an earlier Python index run created for the same
// (docId, chunkIndex). DO NOT REGENERATE without a migration.
const POINT_ID_NAMESPACE = "e9f31cae-1b4a-4c72-9b67-2a4b8b5ed45f";

// Payload fields we filter on at query time. Indexes here turn a linear
// scan over the entire collection into an O(log n) lookup.
const INDEXED_PAYLOAD_FIELDS: Record<string, "integer" | "keyword"> = {
  doc_id: "integer",
  doc_type: "keyword",
  correspondent: "keyword",
  tags: "keyword",
};

/**
 * Per-chunk metadata stored alongside its vector. Includes the chunk's text
 * so the answer LLM can read it directly from a search hit without a
 * second round-trip to Paperless.
 */
export interface ChunkPayload {
  readonly docId: number;
  readonly chunkIndex: number;
  readonly text: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly tokenCount: number;
  readonly docType: string | null;
  readonly correspondent: string | null;
  readonly tags: readonly string[];
  readonly createdDate: string | null; // ISO date (YYYY-MM-DD), null if unknown
  readonly page: number | null;
}

/** One result returned by QdrantVectorStore.search. Frozen — search results
 * travel through the answer pipeline; freezing prevents accidental
 * mutation downstream. */
export interface SearchHit {
  readonly score: number;
  readonly payload: ChunkPayload;
}

/**
 * Server-side narrowing applied at the vector layer. Every field is
 * optional; the absence of all of them means an unconstrained
 * nearest-neighbour search. Multi-value filters use Qdrant's "match any"
 * semantics; AND semantics across different fields are implicit (MUST).
 */
export interface SearchFilter {
  docTypes?: readonly string[];
  correspondents?: readonly string[];
  tags?: readonly string[];
  docIds?: readonly number[];
}

export interface QdrantVectorStoreOptions {
  collection?: string;
  denseDim?: number;
  /** Dependency-injection seam for testing — pass a fake QdrantClient. */
  client?: QdrantClient;
}

export class QdrantVectorStore {
  private readonly client: QdrantClient;
  private readonly collectionName: string;
  private readonly denseDim: number;

  constructor(url: string, options: QdrantVectorStoreOptions = {}) {
    this.client = options.client ?? new QdrantClient({ url });
    this.collectionName = options.collection ?? DEFAULT_COLLECTION;
    this.denseDim = options.denseDim ?? DENSE_DIM;
  }

  get collection(): string {
    return this.collectionName;
  }

  /**
   * Create the collection if it doesn't exist; ensure payload indexes
   * either way. Idempotent — safe to call on every service startup as the
   * source of truth for the schema.
   */
  async ensureCollection(): Promise<void> {
    const { exists } = await this.client.collectionExists(this.collectionName);
    if (!exists) {
      await this.client.createCollection(this.collectionName, {
        vectors: { size: this.denseDim, distance: "Cosine" },
      });
      logger.info("qdrant_collection_created", {
        collection: this.collectionName,
        dense_dim: this.denseDim,
      });
    }
    await this.ensurePayloadIndexes();
  }

  /**
   * Create payload indexes that are missing. Existing indexes are left
   * alone (Qdrant errors on "already exists", which we treat as success).
   * Without indexes, payload filters degrade to a linear scan.
   */
  private async ensurePayloadIndexes(): Promise<void> {
    for (const [field, schema] of Object.entries(INDEXED_PAYLOAD_FIELDS)) {
      try {
        await this.client.createPayloadIndex(this.collectionName, {
          field_name: field,
          field_schema: schema,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.toLowerCase().includes("already exists")) continue;
        logger.warn("qdrant_payload_index_failed", { field, error: message });
      }
    }
  }

  /**
   * Upsert the given (chunk, embedding) pairs for one document. Reuses the
   * same point ID for each (docId, chunkIndex) pair so re-running the
   * indexer for a document replaces existing chunks in place rather than
   * producing duplicates. Returns the number of points written.
   *
   * Empty input -> zero. Mismatched lengths between chunks and embeddings
   * is a programmer error and throws.
   */
  async upsertChunks(
    chunks: readonly Chunk[],
    embeddings: readonly (readonly number[])[],
    options: {
      docId: number;
      docType?: string | null;
      correspondent?: string | null;
      tags?: readonly string[];
      createdDate?: string | null;
    },
  ): Promise<number> {
    if (chunks.length !== embeddings.length) {
      throw new Error(
        `chunks (${chunks.length}) and embeddings (${embeddings.length}) must be the same length`,
      );
    }
    if (chunks.length === 0) return 0;

    const points = chunks.map((chunk, i) => {
      const payload: ChunkPayload = {
        docId: options.docId,
        chunkIndex: chunk.index,
        text: chunk.text,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
        tokenCount: chunk.tokenCount,
        docType: options.docType ?? null,
        correspondent: options.correspondent ?? null,
        tags: options.tags ?? [],
        createdDate: options.createdDate ?? null,
        page: null,
      };
      return {
        id: pointId(options.docId, chunk.index),
        vector: [...embeddings[i]!],
        payload: payloadToDict(payload),
      };
    });

    await this.client.upsert(this.collectionName, { wait: true, points });
    return points.length;
  }

  /**
   * Remove every chunk belonging to `docId`. Used when a doc is
   * reprocessed (lifecycle reset) so stale chunks don't haunt future
   * searches. No-op if the doc isn't indexed.
   */
  async deleteByDocId(docId: number): Promise<void> {
    await this.client.delete(this.collectionName, {
      wait: true,
      filter: { must: [{ key: "doc_id", match: { value: docId } }] },
    });
  }

  /**
   * Refresh only the metadata fields of every point belonging to `docId` —
   * text, chunkIndex, charStart, charEnd, tokenCount, and the vector itself
   * are left untouched.
   *
   * Uses Qdrant's set_payload (merges keys into the existing payload)
   * rather than upsertChunks (which replaces the whole point, vector
   * included). This is the cheap path for a metadata-only change — e.g. a
   * native tag edit on a document that's already indexed — where the
   * underlying chunk text hasn't changed and re-embedding would be wasted
   * work.
   *
   * No-op, not an error, when `docId` has no points indexed yet.
   */
  async updateMetadataByDocId(
    docId: number,
    options: {
      docType?: string | null;
      correspondent?: string | null;
      tags?: readonly string[];
      createdDate?: string | null;
    } = {},
  ): Promise<void> {
    const payload = {
      doc_type: options.docType ?? null,
      correspondent: options.correspondent ?? null,
      tags: [...(options.tags ?? [])],
      created_date: options.createdDate ?? null,
    };
    await this.client.setPayload(this.collectionName, {
      payload,
      filter: { must: [{ key: "doc_id", match: { value: docId } }] },
      wait: true,
    });
  }

  /**
   * Nearest-neighbour search with optional payload filtering. `topK=50` is
   * the recommended fan-out before reranker — higher than the answer LLM
   * ever sees, but the reranker re-ranks cheaply enough that a wide first
   * stage helps recall.
   */
  async search(
    queryVector: readonly number[],
    options: { topK?: number; filter?: SearchFilter } = {},
  ): Promise<SearchHit[]> {
    const topK = options.topK ?? 50;
    const qdrantFilter = options.filter ? buildQdrantFilter(options.filter) : undefined;
    const result = await this.client.query(this.collectionName, {
      query: [...queryVector],
      limit: topK,
      filter: qdrantFilter,
      with_payload: true,
    });
    return result.points.map((p) =>
      Object.freeze({
        score: p.score,
        payload: payloadFromDict((p.payload ?? {}) as Record<string, unknown>),
      }),
    );
  }

  /**
   * How many chunks are currently stored for `docId`. Used by the backfill
   * script to skip already-indexed docs without a full payload read.
   */
  async countChunksForDoc(docId: number): Promise<number> {
    const result = await this.client.count(this.collectionName, {
      filter: { must: [{ key: "doc_id", match: { value: docId } }] },
      exact: true,
    });
    return result.count;
  }

  /**
   * Returns true if the collection exists and Qdrant is responsive.
   * Non-throwing — a failure becomes false so the caller can render a
   * status indicator instead of an exception trace.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const { exists } = await this.client.collectionExists(this.collectionName);
      return exists;
    } catch (e) {
      logger.warn("qdrant_health_check_failed", {
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }
}

/**
 * Deterministic UUID5 from (docId, chunkIndex). Stable across re-indexing
 * runs so upserts replace rather than duplicate.
 */
export function pointId(docId: number, chunkIndex: number): string {
  return uuidv5(`${docId}:${chunkIndex}`, POINT_ID_NAMESPACE);
}

/**
 * ChunkPayload -> plain dict for Qdrant's wire format (snake_case keys,
 * matching the Python side's payload shape exactly so a mixed-language
 * deployment during migration reads consistent payloads either way).
 */
export function payloadToDict(payload: ChunkPayload): Record<string, unknown> {
  return {
    doc_id: payload.docId,
    chunk_index: payload.chunkIndex,
    text: payload.text,
    char_start: payload.charStart,
    char_end: payload.charEnd,
    token_count: payload.tokenCount,
    doc_type: payload.docType,
    correspondent: payload.correspondent,
    tags: [...payload.tags],
    created_date: payload.createdDate,
    page: payload.page,
  };
}

/** Wire dict -> ChunkPayload. Tolerates missing fields. */
export function payloadFromDict(raw: Record<string, unknown>): ChunkPayload {
  const createdRaw = raw["created_date"];
  const createdDate = typeof createdRaw === "string" ? createdRaw.slice(0, 10) : null;
  return Object.freeze({
    docId: Number(raw["doc_id"] ?? 0),
    chunkIndex: Number(raw["chunk_index"] ?? 0),
    text: String(raw["text"] ?? ""),
    charStart: Number(raw["char_start"] ?? 0),
    charEnd: Number(raw["char_end"] ?? 0),
    tokenCount: Number(raw["token_count"] ?? 0),
    docType: (raw["doc_type"] as string | null | undefined) ?? null,
    correspondent: (raw["correspondent"] as string | null | undefined) ?? null,
    tags: Array.isArray(raw["tags"]) ? (raw["tags"] as string[]) : [],
    createdDate,
    page: (raw["page"] as number | null | undefined) ?? null,
  });
}

/**
 * Compose a Qdrant filter from our small SearchFilter shape. All
 * conditions go into MUST, so different fields AND together; a single
 * field with multiple values uses MatchAny so its values OR together.
 */
export function buildQdrantFilter(f: SearchFilter) {
  const must: Record<string, unknown>[] = [];
  if (f.docIds && f.docIds.length > 0) {
    must.push({ key: "doc_id", match: { any: [...f.docIds] } });
  }
  if (f.docTypes && f.docTypes.length > 0) {
    must.push({ key: "doc_type", match: { any: [...f.docTypes] } });
  }
  if (f.correspondents && f.correspondents.length > 0) {
    must.push({ key: "correspondent", match: { any: [...f.correspondents] } });
  }
  if (f.tags && f.tags.length > 0) {
    must.push({ key: "tags", match: { any: [...f.tags] } });
  }
  return { must };
}
