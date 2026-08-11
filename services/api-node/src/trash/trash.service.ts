import { logger, type QdrantVectorStore } from "@aktenraum/core-ts";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";

import { customFieldValues, parseDate } from "../inbox/inbox.service.js";
import { PaperlessNotFoundError } from "../paperless/errors.js";
import type { PaperlessDocument, PaperlessGateway } from "../paperless/paperless.gateway.js";
import { PaperlessGatewayProvider } from "../paperless/paperless.module.js";
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
    private readonly gatewayProvider: PaperlessGatewayProvider,
    @Inject(VECTOR_STORE) private readonly vectorStore: QdrantVectorStore | null,
  ) {}

  private gateway(): PaperlessGateway {
    return this.gatewayProvider.require();
  }

  async listTrashed(options: {
    page: number;
    pageSize: number;
    ordering?: string;
  }): Promise<TrashList> {
    const gateway = this.gateway();
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

  async restore(docId: number): Promise<void> {
    await this.notInTrashOnMissing(docId, () => this.gateway().restoreDocuments([docId]));
  }

  async deleteForever(docId: number): Promise<void> {
    await this.notInTrashOnMissing(docId, () => this.gateway().emptyTrash([docId]));
    await this.purgeChunks([docId]);
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

  async empty(): Promise<EmptyTrashResponse> {
    const ids = await this.listAllTrashedIds();
    if (ids.length === 0) return { emptied: 0 };
    await this.gateway().emptyTrash(ids);
    await this.purgeChunks(ids);
    return { emptied: ids.length };
  }

  private async listAllTrashedIds(): Promise<number[]> {
    const gateway = this.gateway();
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
