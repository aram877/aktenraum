import { logger } from "@aktenraum/core-ts";
import { Inject, Injectable } from "@nestjs/common";

import { SETTINGS, type Settings } from "../config/settings.js";

export type Trigger = "extract" | "propagate" | "reindex-metadata";

export interface ProcessingState {
  processing?: number[];
  slots?: Record<string, unknown>;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class AutoTaggerClient {
  constructor(@Inject(SETTINGS) private readonly settings: Settings) {}

  private secretHeaders(): Record<string, string> {
    return this.settings.WEBHOOK_SECRET
      ? { "X-Aktenraum-Secret": this.settings.WEBHOOK_SECRET }
      : {};
  }

  async ping(
    docId: number,
    options: { trigger: Trigger; timeoutMs?: number },
  ): Promise<boolean> {
    if (!this.settings.AUTO_TAGGER_URL) return false;
    const base = this.settings.AUTO_TAGGER_URL.replace(/\/+$/, "");
    const url = `${base}/trigger/${options.trigger}`;
    try {
      const resp = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...this.secretHeaders() },
          body: JSON.stringify({ document_id: docId }),
        },
        options.timeoutMs ?? 10_000,
      );
      if (resp.status >= 400) {
        logger.warn("auto_tagger_ping_rejected", {
          trigger: options.trigger,
          doc_id: docId,
          status: resp.status,
          body: (await resp.text()).slice(0, 200),
        });
        return false;
      }
      return true;
    } catch (error: unknown) {
      logger.warn("auto_tagger_ping_failed", {
        trigger: options.trigger,
        doc_id: docId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async fetchProcessingState(options: { timeoutMs?: number } = {}): Promise<ProcessingState | null> {
    if (!this.settings.AUTO_TAGGER_URL) return null;
    const base = this.settings.AUTO_TAGGER_URL.replace(/\/+$/, "");
    try {
      const resp = await fetchWithTimeout(
        `${base}/processing`,
        { method: "GET", headers: this.secretHeaders() },
        options.timeoutMs ?? 2_000,
      );
      if (resp.status >= 400) {
        logger.info("auto_tagger_processing_unexpected_status", { status: resp.status });
        return null;
      }
      return (await resp.json()) as ProcessingState;
    } catch (error: unknown) {
      logger.info("auto_tagger_processing_unreachable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
