import { logger, QdrantVectorStore } from "@aktenraum/core";
import { Global, Module } from "@nestjs/common";

import { SETTINGS, type Settings } from "../config/settings.js";

export const VECTOR_STORE = Symbol("AKTENRAUM_VECTOR_STORE");

@Global()
@Module({
  providers: [
    {
      provide: VECTOR_STORE,
      inject: [SETTINGS],
      useFactory: (settings: Settings): QdrantVectorStore | null => {
        if (!settings.QDRANT_URL) return null;
        const store = new QdrantVectorStore(settings.QDRANT_URL);
        void store.ensureCollection().catch((error: unknown) => {
          logger.warn("qdrant_ensure_collection_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return store;
      },
    },
  ],
  exports: [VECTOR_STORE],
})
export class RagModule {}
