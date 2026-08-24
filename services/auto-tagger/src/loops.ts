import { logger } from "@aktenraum/core";

import type { AsyncQueue } from "./queue.js";
import type { ProcessingState, Slot } from "./processing-state.js";

export interface Stoppable {
  readonly stopped: boolean;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Drain a queue serially, with a per-document fault boundary.
 *
 * The boundary is the point: one document that throws must not kill the
 * consumer, or a single malformed PDF stops the whole pipeline until the
 * container restarts. Mirrors the Python worker's per-doc try/except.
 */
export async function runQueueConsumer(options: {
  name: string;
  queue: AsyncQueue<number>;
  slot: Slot;
  processingState: ProcessingState;
  handle: (docId: number) => Promise<void>;
  signal: AbortSignal;
}): Promise<void> {
  const { name, queue, slot, processingState, handle, signal } = options;
  logger.info("loop_started", { loop: name });
  while (!signal.aborted) {
    const docId = await queue.pop();
    if (docId === null) break;
    processingState.set(slot, docId);
    try {
      await handle(docId);
    } catch (error: unknown) {
      logger.error("loop_doc_failed", {
        loop: name,
        doc_id: docId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      processingState.set(slot, null);
    }
  }
  logger.info("loop_stopped", { loop: name });
}

/**
 * Run `tick` every `intervalMs` until aborted. A throwing tick is logged and
 * the loop continues — a transient Paperless outage must not stop the poller
 * permanently, since it is the safety net for missed webhooks.
 */
export async function runInterval(options: {
  name: string;
  intervalMs: number;
  tick: () => Promise<void>;
  signal: AbortSignal;
}): Promise<void> {
  const { name, intervalMs, tick, signal } = options;
  logger.info("loop_started", { loop: name });
  while (!signal.aborted) {
    try {
      await tick();
    } catch (error: unknown) {
      logger.error("loop_tick_failed", {
        loop: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (signal.aborted) break;
    await sleep(intervalMs, signal);
  }
  logger.info("loop_stopped", { loop: name });
}
