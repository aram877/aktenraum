import {
  logger,
  type ChunkPayload,
  type Embedder,
  type QdrantVectorStore,
  type RerankCandidate,
  type Reranker,
  type SearchAccess,
  type SearchFilter as VectorSearchFilter,
} from "@aktenraum/core";

import type { SearchFilter } from "./ai.schemas.js";

export interface RetrievedChunk {
  docId: number;
  chunkIndex: number;
  text: string;
  score: number;
  docType: string | null;
  correspondent: string | null;
  tags: readonly string[];
  createdDate: string | null;
  page: number | null;
}

export interface RetrievalDeps {
  embedder: Embedder;
  vectorStore: QdrantVectorStore;
  /** null = `RERANKER_ENABLED=false`: keep Qdrant's dense order. */
  reranker: Reranker | null;
}

/** Qdrant's own order and scores, used without a reranker and when reranking fails. */
function denseOrder(
  candidates: readonly RerankCandidate[],
  hits: readonly { score: number }[],
  topK: number,
): { id: string; score: number }[] {
  return candidates.slice(0, topK).map((candidate, index) => ({
    id: candidate.id,
    score: hits[index]?.score ?? 0,
  }));
}

function chunkKey(payload: ChunkPayload): string {
  return `${payload.docId}:${payload.chunkIndex}`;
}

function toVectorFilter(filter: SearchFilter): VectorSearchFilter {
  return {
    docTypes: filter.document_type !== null ? [filter.document_type] : [],
    correspondents: filter.correspondent ? [filter.correspondent] : [],
    tags: [...filter.tags],
    docIds: [],
  };
}

function payloadToRetrieved(payload: ChunkPayload, score: number): RetrievedChunk {
  return {
    docId: payload.docId,
    chunkIndex: payload.chunkIndex,
    text: payload.text,
    score,
    docType: payload.docType,
    correspondent: payload.correspondent,
    tags: [...payload.tags],
    createdDate: payload.createdDate,
    page: payload.page,
  };
}

export async function retrieveChunksForQuestion(
  question: string,
  options: {
    deps: RetrievalDeps;
    structuralFilter?: SearchFilter | null;
    /** Tenancy restriction for member requests (ADR-009); omitted only for service use (eval). */
    access?: SearchAccess;
    fetchTopK?: number;
    rerankTopK?: number;
  },
): Promise<RetrievedChunk[]> {
  if (question.trim() === "") return [];
  const fetchTopK = options.fetchTopK ?? 50;
  const rerankTopK = options.rerankTopK ?? 5;

  const started = performance.now();
  let embeddings: number[][];
  try {
    embeddings = await options.deps.embedder.embedDense([question]);
  } catch (error: unknown) {
    logger.warn("rag_retrieve_embed_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  const queryVec = embeddings[0];
  if (queryVec === undefined) return [];
  const embedded = performance.now();

  const structural =
    options.structuralFilter !== null && options.structuralFilter !== undefined
      ? toVectorFilter(options.structuralFilter)
      : undefined;
  const qfilter =
    options.access !== undefined ? { ...(structural ?? {}), access: options.access } : structural;

  let hits;
  try {
    hits = await options.deps.vectorStore.search(queryVec, { topK: fetchTopK, filter: qfilter });
  } catch (error: unknown) {
    logger.warn("rag_retrieve_qdrant_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  if (hits.length === 0) return [];
  const searched = performance.now();

  const candidates: RerankCandidate[] = hits.map((hit) => ({
    id: chunkKey(hit.payload),
    text: hit.payload.text,
  }));

  let ranked: { id: string; score: number }[];
  let rerankerUsed = false;
  if (options.deps.reranker === null) {
    ranked = denseOrder(candidates, hits, rerankTopK);
  } else {
    try {
      ranked = await options.deps.reranker.rerank(question, candidates, { topK: rerankTopK });
      rerankerUsed = true;
    } catch (error: unknown) {
      logger.warn("rag_retrieve_rerank_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      ranked = denseOrder(candidates, hits, rerankTopK);
    }
  }

  const payloadByKey = new Map(hits.map((hit) => [chunkKey(hit.payload), hit.payload]));
  const out: RetrievedChunk[] = [];
  for (const result of ranked) {
    const payload = payloadByKey.get(result.id);
    if (payload === undefined) continue;
    out.push(payloadToRetrieved(payload, result.score));
  }

  const reranked = performance.now();
  logger.info("rag_retrieve_complete", {
    embed_ms: Math.round(embedded - started),
    search_ms: Math.round(searched - embedded),
    rerank_ms: Math.round(reranked - searched),
    candidates: hits.length,
    reranked: ranked.length,
    reranker_used: rerankerUsed,
    returned: out.length,
    top_doc_ids: out.map((chunk) => chunk.docId),
  });
  return out;
}
