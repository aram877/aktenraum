import { logger, type QdrantVectorStore } from "@aktenraum/core";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { inArray } from "drizzle-orm";

import { DB, type Database } from "../db/db.module.js";
import { documentShares, documentSpaces } from "../db/schema.js";
import { MemberGateways } from "../tenancy/member-gateways.js";
import type { Principal } from "../auth/principal.js";

import { customFieldValues, parseDate } from "../inbox/inbox.service.js";
import { PaperlessNotFoundError } from "../paperless/errors.js";
import type { PaperlessDocument, PaperlessGateway } from "../paperless/paperless.gateway.js";
import { VECTOR_STORE } from "../rag/rag.module.js";
import type { EmptyTrashResponse, TrashItem, TrashList } from "./trash.schemas.js";

const DEFAULT_ORDERING = "deleted_at";

function invert(mapping: Record<string, number>): Map<number, string> {
  return new Map(Object.entries(mapping).map(([name, id]) => [id, name]));
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

export function parseDateTime(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

@Injectable()
export class TrashService {
  constructor(
    private readonly gateways: MemberGateways,
    @Inject(VECTOR_STORE) private readonly vectorStore: QdrantVectorStore | null,
    @Inject(DB) private readonly db: Database,
  ) {}

  /** The member's own Paperless gateway (service gateway for the worker). */
  private gateway(principal: Principal): Promise<PaperlessGateway> {
    return this.gateways.forPrincipal(principal);
  }

  async listTrashed(principal: Principal, options: {
    page: number;
    pageSize: number;
    ordering?: string;
  }): Promise<TrashList> {
    const gateway = await this.gateway(principal);
    const payload = await gateway.listTrashedDocuments({
      page: options.page,
      pageSize: options.pageSize,
      ordering: options.ordering ?? DEFAULT_ORDERING,
    });
    const rows = (payload.results as PaperlessDocument[] | undefined) ?? [];
    if (rows.length === 0) {
      return { results: [], total: 0, page: options.page, page_size: options.pageSize };
    }

    const fieldIdToName = invert(await gateway.getCustomFieldIds());
    const correspondentById = invert(await gateway.listCorrespondents());
    const doctypeById = invert(await gateway.listDocumentTypes());
    const items = rows.map((doc) =>
      this.project(doc, fieldIdToName, correspondentById, doctypeById),
    );
    return {
      results: items,
      total: typeof payload.count === "number" ? payload.count : items.length,
      page: options.page,
      page_size: options.pageSize,
    };
  }

  async restore(principal: Principal, docId: number): Promise<void> {
    const gateway = await this.gateway(principal);
    await this.notInTrashOnMissing(docId, () => gateway.restoreDocuments([docId]));
  }

  async deleteForever(principal: Principal, docId: number): Promise<void> {
    const gateway = await this.gateway(principal);
    await this.notInTrashOnMissing(docId, () => gateway.emptyTrash([docId]));
    await this.purgeChunks([docId]);
    await this.forgetHomeSpaces([docId]);
  }

  private async notInTrashOnMissing(docId: number, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error: unknown) {
      if (error instanceof PaperlessNotFoundError) {
        throw new NotFoundException(`Document ${docId} not in trash`);
      }
      throw error;
    }
  }

  async empty(principal: Principal): Promise<EmptyTrashResponse> {
    const ids = await this.listAllTrashedIds(principal);
    if (ids.length === 0) return { emptied: 0 };
    await (await this.gateway(principal)).emptyTrash(ids);
    await this.purgeChunks(ids);
    await this.forgetHomeSpaces(ids);
    return { emptied: ids.length };
  }

  private async listAllTrashedIds(principal: Principal): Promise<number[]> {
    const gateway = await this.gateway(principal);
    const ids: number[] = [];
    let page = 1;
    for (;;) {
      const payload = await gateway.listTrashedDocuments({ page, pageSize: 100 });
      for (const row of (payload.results as PaperlessDocument[] | undefined) ?? []) {
        ids.push(Number(row.id));
      }
      if (!payload.next) return ids;
      page += 1;
    }
  }

  /**
   * A hard-deleted document no longer exists, so its home-space row goes too —
   * otherwise its space could never be deleted ("empty incl. trash") — and so
   * do its shares (the audit entries stay).
   */
  private async forgetHomeSpaces(docIds: number[]): Promise<void> {
    try {
      await this.db.delete(documentShares).where(inArray(documentShares.paperlessDocId, docIds));
      await this.db.delete(documentSpaces).where(inArray(documentSpaces.paperlessDocId, docIds));
    } catch (error: unknown) {
      logger.warn("trash_home_space_cleanup_failed", {
        doc_ids: docIds,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async purgeChunks(docIds: number[]): Promise<void> {
    if (this.vectorStore === null || docIds.length === 0) return;
    for (const docId of docIds) {
      try {
        await this.vectorStore.deleteByDocId(docId);
      } catch (error: unknown) {
        logger.warn("trash_qdrant_purge_failed", {
          doc_id: docId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private project(
    doc: PaperlessDocument,
    fieldIdToName: Map<number, string>,
    correspondentById: Map<number, string>,
    doctypeById: Map<number, string>,
  ): TrashItem {
    const fields = customFieldValues(doc, fieldIdToName);
    const correspondentId = doc.correspondent;
    const documentTypeId = doc.document_type;
    return {
      id: doc.id,
      title: asString(doc.title) || `Dokument #${doc.id}`,
      original_file_name: asString(doc.original_file_name),
      created: parseDate(doc.created_date ?? doc.created),
      deleted_at: parseDateTime(doc.deleted_at),
      correspondent:
        typeof correspondentId === "number"
          ? (correspondentById.get(correspondentId) ?? null)
          : null,
      document_type:
        typeof documentTypeId === "number" ? (doctypeById.get(documentTypeId) ?? null) : null,
      ai_correspondent: asString(fields.ai_correspondent),
      ai_document_type: asString(fields.ai_document_type),
      ai_summary_de: asString(fields.ai_summary_de),
    };
  }
}
