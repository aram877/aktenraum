import {
  logger,
  type ChunkPayload,
  type Embedder,
  type QdrantVectorStore,
  type RerankCandidate,
  type Reranker,
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
  reranker: Reranker;
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
    fetchTopK?: number;
    rerankTopK?: number;
  },
): Promise<RetrievedChunk[]> {
  if (question.trim() === "") return [];
  const fetchTopK = options.fetchTopK ?? 50;
  const rerankTopK = options.rerankTopK ?? 5;

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

  const qfilter =
    options.structuralFilter !== null && options.structuralFilter !== undefined
      ? toVectorFilter(options.structuralFilter)
      : undefined;

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

  const candidates: RerankCandidate[] = hits.map((hit) => ({
    id: chunkKey(hit.payload),
    text: hit.payload.text,
  }));

  let ranked: { id: string; score: number }[];
  try {
    ranked = await options.deps.reranker.rerank(question, candidates, { topK: rerankTopK });
  } catch (error: unknown) {
    logger.warn("rag_retrieve_rerank_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    ranked = candidates.slice(0, rerankTopK).map((candidate, index) => ({
      id: candidate.id,
      score: hits[index]?.score ?? 0,
    }));
  }

  const payloadByKey = new Map(hits.map((hit) => [chunkKey(hit.payload), hit.payload]));
  const out: RetrievedChunk[] = [];
  for (const result of ranked) {
    const payload = payloadByKey.get(result.id);
    if (payload === undefined) continue;
    out.push(payloadToRetrieved(payload, result.score));
  }

  logger.info("rag_retrieve_complete", {
    candidates: hits.length,
    reranked: ranked.length,
    returned: out.length,
    top_doc_ids: out.map((chunk) => chunk.docId),
  });
  return out;
}
