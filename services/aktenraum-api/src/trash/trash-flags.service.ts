import { logger, type QdrantVectorStore } from "@aktenraum/core";
import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";

import type { PaperlessDocument, PaperlessGateway } from "../paperless/paperless.gateway.js";
import { PaperlessGatewayProvider } from "../paperless/paperless.module.js";
import { VECTOR_STORE } from "../rag/rag.module.js";

export const TRASH_RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps the Qdrant `trashed` flag in step with the Paperless trash, so Ask
 * never retrieves chunks of a document the user binned (soft delete keeps
 * the chunks until the trash is emptied).
 *
 * - `markTrashed` / `markRestored` run right after aktenraum's own delete
 *   and restore — best effort: a Qdrant failure is logged, never fails the
 *   user's request (the reconcile below repairs it).
 * - `reconcile` runs at startup and hourly against the full trash list
 *   (service gateway — the superuser sees every member's trash). It covers
 *   documents trashed before the flag existed and deletes/restores done in
 *   Paperless's own UI.
 */
@Injectable()
export class TrashFlagsService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(VECTOR_STORE) private readonly vectorStore: QdrantVectorStore | null,
    private readonly gatewayProvider: PaperlessGatewayProvider,
  ) {}

  onApplicationBootstrap(): void {
    if (this.vectorStore === null) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), TRASH_RECONCILE_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  markTrashed(docId: number): Promise<void> {
    return this.setFlag(docId, true);
  }

  markRestored(docId: number): Promise<void> {
    return this.setFlag(docId, false);
  }

  private async setFlag(docId: number, trashed: boolean): Promise<void> {
    if (this.vectorStore === null) return;
    try {
      await this.vectorStore.setTrashedByDocId(docId, trashed);
    } catch (error: unknown) {
      logger.warn("trash_qdrant_flag_failed", { doc_id: docId, trashed, error: errorText(error) });
    }
  }

  /** Returns false when skipped or failed (logged), true when the flags were rewritten. */
  async reconcile(): Promise<boolean> {
    const gateway = this.gatewayProvider.optional();
    if (this.vectorStore === null || gateway === null) return false;
    try {
      const ids = await this.allTrashedIds(gateway);
      await this.vectorStore.reconcileTrashed(ids);
      logger.info("trash_qdrant_reconcile_completed", { trashed: ids.length });
      return true;
    } catch (error: unknown) {
      logger.warn("trash_qdrant_reconcile_failed", { error: errorText(error) });
      return false;
    }
  }

  private async allTrashedIds(gateway: PaperlessGateway): Promise<number[]> {
    const ids: number[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const payload = await gateway.listTrashedDocuments({ page, pageSize: 100 });
      for (const doc of (payload.results as PaperlessDocument[] | undefined) ?? []) ids.push(Number(doc.id));
      if (!payload.next) return ids;
    }
    // More than 10,000 trashed documents: flagging a partial list would clear
    // the flag on the rest, so leave everything as it is.
    throw new Error("trash larger than 10000 documents; reconcile skipped");
  }
}
