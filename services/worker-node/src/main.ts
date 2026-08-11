import { logger, PaperlessClient } from "@aktenraum/core-ts";

import { AutoApproveConfig } from "./auto-approve-config.js";
import { loadSettings } from "./config.js";
import { runInterval, runQueueConsumer } from "./loops.js";
import { ProcessingState } from "./processing-state.js";
import { AsyncQueue } from "./queue.js";
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
  const indexingQueue = new AsyncQueue<number>();
  const autoApprove = new AutoApproveConfig(
    settings.AKTENRAUM_API_URL,
    settings.WEBHOOK_SECRET,
  );

  const controller = new AbortController();
  const shutdown = (signal: string): void => {
    logger.info("worker_shutdown_requested", { signal });
    controller.abort();
    extractionQueue.close();
    propagationQueue.close();
    indexingQueue.close();
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
        logger.info("extraction_dequeued", { doc_id: docId });
        await autoApprove.getRules();
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
          logger.info("propagation_dequeued", { doc_id: docId });
        },
      }),
    );
  }

  if (settings.QDRANT_URL) {
    loops.push(
      runQueueConsumer({
        name: "indexer",
        queue: indexingQueue,
        slot: "indexer",
        processingState,
        signal: controller.signal,
        handle: async (docId) => {
          logger.info("indexer_dequeued", { doc_id: docId });
        },
      }),
    );
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
    rag: Boolean(settings.QDRANT_URL),
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
