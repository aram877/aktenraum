import { logger, type ChunkPayload, type QdrantVectorStore, type Reranker } from "@aktenraum/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TEST_ENV } from "../test/harness.js";
import { loadSettings } from "../config/settings.js";
import { retrieveChunksForQuestion, type RetrievalDeps } from "./retrieval.js";

function payload(docId: number): ChunkPayload {
  return {
    docId,
    chunkIndex: 0,
    text: `chunk of ${docId}`,
    charStart: 0,
    charEnd: 10,
    tokenCount: 3,
    docType: "Rechnung",
    correspondent: null,
    tags: [],
    createdDate: null,
    page: null,
    spaceId: 1,
    sharedWith: [],
  };
}

// Qdrant order: doc 1 best, doc 4 worst.
const HITS = [1, 2, 3, 4].map((docId, index) => ({ score: 0.9 - index * 0.1, payload: payload(docId) }));

function deps(reranker: Reranker | null): RetrievalDeps {
  return {
    embedder: { embedDense: async () => [[0.1, 0.2]] } as unknown as RetrievalDeps["embedder"],
    vectorStore: { search: async () => HITS } as unknown as QdrantVectorStore,
    reranker,
  };
}

const reversing: Reranker = {
  name: "fake",
  model: "fake",
  rerank: async (_q, candidates, options) =>
    [...candidates].reverse().slice(0, options?.topK ?? 5).map((c, i) => ({ id: c.id, score: 10 - i })),
};

const failing: Reranker = {
  name: "fake",
  model: "fake",
  rerank: async () => {
    throw new Error("model gone");
  },
};

function completeEvent(info: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const call = info.mock.calls.find((c) => c[0] === "rag_retrieve_complete");
  return (call?.[1] ?? {}) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retrieveChunksForQuestion without a reranker", () => {
  it("keeps Qdrant's order and scores and logs no rerank failure", async () => {
    const warn = vi.spyOn(logger, "warn");
    const info = vi.spyOn(logger, "info");
    const out = await retrieveChunksForQuestion("Frage", { deps: deps(null), rerankTopK: 2 });
    expect(out.map((c) => c.docId)).toEqual([1, 2]);
    expect(out.map((c) => c.score)).toEqual([0.9, 0.8]);
    expect(warn).not.toHaveBeenCalledWith("rag_retrieve_rerank_failed", expect.anything());
    expect(completeEvent(info).reranker_used).toBe(false);
  });
});

describe("retrieveChunksForQuestion with a reranker", () => {
  it("uses the reranker's order", async () => {
    const info = vi.spyOn(logger, "info");
    const out = await retrieveChunksForQuestion("Frage", { deps: deps(reversing), rerankTopK: 2 });
    expect(out.map((c) => c.docId)).toEqual([4, 3]);
    expect(completeEvent(info).reranker_used).toBe(true);
  });

  it("falls back to the same dense order when reranking fails, and says so", async () => {
    const warn = vi.spyOn(logger, "warn");
    const info = vi.spyOn(logger, "info");
    const out = await retrieveChunksForQuestion("Frage", { deps: deps(failing), rerankTopK: 2 });
    expect(out.map((c) => c.docId)).toEqual([1, 2]);
    expect(out.map((c) => c.score)).toEqual([0.9, 0.8]);
    expect(warn).toHaveBeenCalledWith("rag_retrieve_rerank_failed", { error: "model gone" });
    expect(completeEvent(info).reranker_used).toBe(false);
  });
});

describe("RERANKER_ENABLED", () => {
  it("defaults to true", () => {
    expect(loadSettings({ ...TEST_ENV }).RERANKER_ENABLED).toBe(true);
  });

  it("parses false", () => {
    expect(loadSettings({ ...TEST_ENV, RERANKER_ENABLED: "false" }).RERANKER_ENABLED).toBe(false);
  });
});
