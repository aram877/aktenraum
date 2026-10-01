import {
  createBackend,
  logger,
  OllamaEmbedder,
  PaperlessClient,
  QdrantVectorStore,
} from "@aktenraum/core";

import { ActiveModelConfig } from "./active-model.js";
import { AutoApproveConfig } from "./auto-approve-config.js";
import { loadSettings } from "./config.js";
import { runInterval, runQueueConsumer } from "./loops.js";
import { ProcessingState } from "./processing-state.js";
import { AsyncQueue } from "./queue.js";
import { lifecycleTagsOn, processDocument } from "./extract.js";
import {
  enqueueUnindexedDocuments,
  indexDocument,
  reindexMetadata,
  type IndexJob,
} from "./indexer.js";
import { processApprovedDocument } from "./propagate.js";
import { TransientFailureTracker } from "./transient.js";
import { createWebhookServer } from "./webhook.js";

export async function bootstrap(): Promise<void> {
  const settings = loadSettings();

  const paperless = new PaperlessClient(
    settings.PAPERLESS_BASE_URL,
    settings.PAPERLESS_API_TOKEN,
  );
  const processingState = new ProcessingState();
  const extractionQueue = new AsyncQueue<number>();
  const propagationQueue = new AsyncQueue<number>();
  const ragEnabled = Boolean(settings.QDRANT_URL);
  const indexingQueue = ragEnabled ? new AsyncQueue<IndexJob>() : null;
  const transientFailures = new TransientFailureTracker();
  const autoApprove = new AutoApproveConfig(
    settings.AKTENRAUM_API_URL,
    settings.WEBHOOK_SECRET,
  );
  const activeModel = new ActiveModelConfig(
    settings.AKTENRAUM_API_URL,
    settings.WEBHOOK_SECRET,
    settings.OLLAMA_MODEL,
  );
  const buildBackend = (ollamaModel: string) =>
    createBackend(settings.LLM_BACKEND, {
      anthropicApiKey: settings.ANTHROPIC_API_KEY,
      anthropicModel: settings.ANTHROPIC_MODEL,
      ollamaBaseUrl: settings.OLLAMA_BASE_URL,
      ollamaModel,
      ollamaCompleteTimeoutMs: settings.LLM_TIMEOUT_SECONDS * 1000,
      ollamaNumCtx: settings.OLLAMA_NUM_CTX > 0 ? settings.OLLAMA_NUM_CTX : undefined,
    });
  const staticBackend = settings.LLM_BACKEND === "ollama" ? null : buildBackend(settings.OLLAMA_MODEL);

  const controller = new AbortController();
  const shutdown = (signal: string): void => {
    logger.info("worker_shutdown_requested", { signal });
    controller.abort();
    extractionQueue.close();
    propagationQueue.close();
    indexingQueue?.close();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const loops: Promise<void>[] = [];

  loops.push(
    runQueueConsumer({
      name: "extraction",
      queue: extractionQueue,
      slot: "extraction",
      processingState,
      signal: controller.signal,
      handle: async (docId) => {
        const doc = await paperless.getDocument(docId);
        const lifecycleOnDoc = await lifecycleTagsOn(paperless, doc);
        if (lifecycleOnDoc.length > 0) {
          logger.info("skip_already_processed", { doc_id: docId, tags: lifecycleOnDoc });
          return;
        }
        const backend = staticBackend ?? buildBackend(await activeModel.getModel());
        await processDocument(doc, {
          paperless,
          backend,
          settings,
          getRules: () => autoApprove.getRules(),
          transientFailures,
        });
      },
    }),
  );

  loops.push(
    runInterval({
      name: "poller",
      intervalMs: settings.POLL_INTERVAL_SECONDS * 1000,
      signal: controller.signal,
      tick: async () => {
        const docs = await paperless.getUnprocessedDocuments(settings.BATCH_SIZE);
        for (const doc of docs) extractionQueue.push(doc.id);
        if (docs.length > 0) logger.info("poller_enqueued", { count: docs.length });
      },
    }),
  );

  if (settings.ENABLE_PROPAGATION) {
    loops.push(
      runQueueConsumer({
        name: "propagation",
        queue: propagationQueue,
        slot: "propagation",
        processingState,
        signal: controller.signal,
        handle: async (docId) => {
          const doc = await paperless.getDocument(docId);
          await processApprovedDocument(doc, paperless, { indexingQueue });
        },
      }),
    );

    loops.push(
      runInterval({
        name: "propagation-poller",
        intervalMs: settings.POLL_INTERVAL_SECONDS * 1000,
        signal: controller.signal,
        tick: async () => {
          const docs = await paperless.getDocumentsWithTag("ai-approved", settings.BATCH_SIZE);
          for (const doc of docs) propagationQueue.push(doc.id);
          if (docs.length > 0) {
            logger.info("propagation_poller_enqueued", { count: docs.length });
          }
        },
      }),
    );
  }

  if (indexingQueue !== null) {
    const vectorStore = new QdrantVectorStore(settings.QDRANT_URL);
    await vectorStore.ensureCollection().catch((error: unknown) => {
      logger.warn("qdrant_ensure_collection_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const indexingDeps = {
      paperless,
      vectorStore,
      embedder: new OllamaEmbedder(settings.OLLAMA_BASE_URL, settings.EMBEDDING_MODEL),
    };
    loops.push(
      runQueueConsumer<IndexJob>({
        name: "indexer",
        queue: indexingQueue,
        slot: "indexer",
        processingState,
        signal: controller.signal,
        docIdOf: (job) => job.docId,
        handle: async (job) => {
          if (job.kind === "metadata") await reindexMetadata(job.docId, indexingDeps);
          else await indexDocument(job.docId, indexingDeps);
        },
      }),
    );
    void enqueueUnindexedDocuments(paperless, vectorStore, indexingQueue)
      .then((count) => logger.info("index_reconcile_completed", { enqueued: count }))
      .catch((error: unknown) => {
        logger.warn("index_reconcile_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  if (settings.ENABLE_HTTP_SERVER) {
    const server = createWebhookServer({
      extractionQueue,
      propagationQueue,
      indexingQueue,
      processingState,
      webhookSecret: settings.WEBHOOK_SECRET,
    });
    await new Promise<void>((resolve) => server.listen(settings.HTTP_PORT, "0.0.0.0", resolve));
    logger.info("webhook_listening", { port: settings.HTTP_PORT });
    controller.signal.addEventListener("abort", () => server.close(), { once: true });
  }

  logger.info("worker_started", {
    loops: loops.length,
    propagation: settings.ENABLE_PROPAGATION,
    rag: ragEnabled,
  });
  await Promise.all(loops);
  logger.info("worker_stopped");
}

const isEntrypoint = process.argv[1] !== undefined && process.argv[1].endsWith("main.js");
if (isEntrypoint) {
  bootstrap().catch((error: unknown) => {
    logger.error("worker_start_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
