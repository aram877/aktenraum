import { LocalReranker, OllamaEmbedder, logger, type QdrantVectorStore } from "@aktenraum/core";
import { Global, Module } from "@nestjs/common";

import { SETTINGS, type Settings } from "../config/settings.js";
import { VECTOR_STORE } from "../rag/rag.module.js";
import type { RetrievalDeps } from "./retrieval.js";

export const RETRIEVAL_DEPS = Symbol("AKTENRAUM_RETRIEVAL_DEPS");

@Global()
@Module({
  providers: [
    {
      provide: RETRIEVAL_DEPS,
      inject: [SETTINGS, VECTOR_STORE],
      useFactory: (
        settings: Settings,
        vectorStore: QdrantVectorStore | null,
      ): RetrievalDeps | null => {
        if (vectorStore === null) return null;
        const embedder = new OllamaEmbedder(settings.OLLAMA_BASE_URL, settings.EMBEDDING_MODEL);
        if (!settings.RERANKER_ENABLED) {
          // Test / low-memory switch: no model download, no prewarm, dense order.
          logger.info("reranker_disabled");
          return { embedder, vectorStore, reranker: null };
        }
        const reranker = new LocalReranker(settings.RERANKER_MODEL);
        void (async () => {
          try {
            await reranker.rerank("warmup", [{ id: "0", text: "warmup" }], { topK: 1 });
            logger.info("reranker_prewarm_complete");
          } catch (error: unknown) {
            logger.warn("reranker_prewarm_failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();
        return { embedder, vectorStore, reranker };
      },
    },
  ],
  exports: [RETRIEVAL_DEPS],
})
export class RetrievalModule {}
