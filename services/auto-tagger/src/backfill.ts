import {
  OllamaEmbedder,
  PaperlessClient,
  QdrantVectorStore,
  logger,
  type PaperlessDocument,
} from "@aktenraum/core";

import { loadSettings } from "./config.js";
import { indexDocument, type IndexingDeps } from "./indexer.js";

const PAGE_SIZE = 100;

function emit(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

export async function backfill(force: boolean): Promise<number> {
  const settings = loadSettings();
  if (!settings.QDRANT_URL) {
    emit("aborted", { reason: "QDRANT_URL is not set — RAG indexing is disabled" });
    return 1;
  }

  const paperless = new PaperlessClient(settings.PAPERLESS_BASE_URL, settings.PAPERLESS_API_TOKEN);
  const vectorStore = new QdrantVectorStore(settings.QDRANT_URL, { apiKey: settings.QDRANT_API_KEY });
  await vectorStore.ensureCollection();

  const deps: IndexingDeps = {
    paperless,
    vectorStore,
    embedder: new OllamaEmbedder(settings.OLLAMA_BASE_URL, settings.EMBEDDING_MODEL),
  };

  emit("started", { force, collection_ready: true });

  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  let page = 1;

  for (;;) {
    let batch: PaperlessDocument[];
    try {
      batch = await paperless.getDocumentsWithTag("ai-propagated", PAGE_SIZE, "id", { page });
    } catch (error: unknown) {
      emit("page_failed", {
        page,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
    if (batch.length === 0) break;

    for (const doc of batch) {
      const docId = doc.id;
      if (!force) {
        const existing = await vectorStore.countChunksForDoc(docId).catch(() => 0);
        if (existing > 0) {
          skipped += 1;
          emit("doc_skipped", { doc_id: docId, chunks: existing });
          continue;
        }
      }
      try {
        await indexDocument(docId, deps);
        indexed += 1;
        emit("doc_indexed", { doc_id: docId });
      } catch (error: unknown) {
        failed += 1;
        emit("doc_failed", {
          doc_id: docId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (batch.length < PAGE_SIZE) break;
    page += 1;
  }

  emit("completed", { indexed, skipped, failed });
  return failed > 0 ? 2 : 0;
}

const force = process.argv.includes("--force");
backfill(force)
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    logger.error("backfill_crashed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
