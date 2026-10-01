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
export async function runQueueConsumer<T = number>(options: {
  name: string;
  queue: AsyncQueue<T>;
  slot: Slot;
  processingState: ProcessingState;
  handle: (item: T) => Promise<void>;
  signal: AbortSignal;
  docIdOf?: (item: T) => number;
}): Promise<void> {
  const { name, queue, slot, processingState, handle, signal } = options;
  const docIdOf = options.docIdOf ?? ((item: T) => item as unknown as number);
  logger.info("loop_started", { loop: name });
  while (!signal.aborted) {
    const item = await queue.pop();
    if (item === null) break;
    const docId = docIdOf(item);
    processingState.set(slot, docId);
    try {
      await handle(item);
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

export async function retryUntilSuccess<T>(options: {
  name: string;
  run: () => Promise<T>;
  attempts: number;
  delayMs: number;
  signal: AbortSignal;
}): Promise<T | null> {
  for (let attempt = 1; attempt <= options.attempts && !options.signal.aborted; attempt++) {
    try {
      return await options.run();
    } catch (error: unknown) {
      logger.warn(`${options.name}_failed`, {
        attempt,
        max_attempts: options.attempts,
        error: error instanceof Error ? error.message : String(error),
      });
      if (attempt < options.attempts) await sleep(options.delayMs, options.signal);
    }
  }
  return null;
}
