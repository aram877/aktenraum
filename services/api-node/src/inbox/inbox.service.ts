import { Injectable } from "@nestjs/common";

import { AutoTaggerClient } from "../auto-tagger/auto-tagger.client.js";
import type { CustomFieldEntry, PaperlessDocument, PaperlessGateway } from "../paperless/paperless.gateway.js";
import { PaperlessGatewayProvider } from "../paperless/paperless.module.js";
import { collectTagIds } from "../paperless/tag-ids.js";
import { TypeFieldsService } from "../type-fields/type-fields.service.js";
import {
  populatedFields,
  type InboxDetail,
  type InboxFieldUpdate,
  type InboxItem,
  type InboxList,
} from "./inbox.schemas.js";

export const PENDING_TAG = "ai-pending";
export const APPROVED_TAG = "ai-approved";
export const REJECTED_TAG = "ai-rejected";
export const LOW_CONFIDENCE_TAG = "ai-low-confidence";

const CONTENT_EXCERPT_LIMIT = 2000;

export function parseDate(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 10) return null;
  const candidate = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return candidate;
}

export function customFieldValues(
  doc: PaperlessDocument,
  fieldIdToName: Map<number, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const cf of (doc.custom_fields as CustomFieldEntry[] | undefined) ?? []) {
    const name = fieldIdToName.get(cf.field);
    if (name !== undefined) out[name] = cf.value;
  }
  return out;
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

@Injectable()
export class InboxService {
  constructor(
    private readonly gatewayProvider: PaperlessGatewayProvider,
    private readonly typeFields: TypeFieldsService,
    private readonly autoTagger: AutoTaggerClient,
  ) {}

  private gateway(): PaperlessGateway {
    return this.gatewayProvider.require();
  }

  private async fieldIdToName(gateway: PaperlessGateway): Promise<Map<number, string>> {
    const nameToId = await gateway.getCustomFieldIds();
    return new Map(Object.entries(nameToId).map(([name, id]) => [id, name]));
  }

  async listPending(options: {
    page: number;
    pageSize: number;
    ordering: string;
  }): Promise<InboxList> {
    const gateway = this.gateway();
    const nameToId = await gateway.listTags();
    const pendingId = nameToId[PENDING_TAG];
    const lowConfId = nameToId[LOW_CONFIDENCE_TAG];
    if (pendingId === undefined) {
      return { results: [], total: 0, page: options.page, page_size: options.pageSize };
    }

    const payload = await gateway.searchDocuments(
      { tags__id: pendingId, ordering: options.ordering, page: options.page },
      { pageSize: options.pageSize },
    );
    const fieldIdToName = await this.fieldIdToName(gateway);
    const docs = (payload.results as PaperlessDocument[] | undefined) ?? [];
    const results = docs.map((doc) =>
      this.projectItem(doc, fieldIdToName, lowConfId ?? null),
    );
    return {
      results,
      total: typeof payload.count === "number" ? payload.count : results.length,
      page: options.page,
      page_size: options.pageSize,
    };
  }

  async getDetail(docId: number, options: { withTypeFields?: boolean } = {}): Promise<InboxDetail> {
    const gateway = this.gateway();
    const doc = await gateway.getDocument(docId);
    const fieldIdToName = await this.fieldIdToName(gateway);
    const tagIdToName = new Map(
      Object.entries(await gateway.listTagsCovering(collectTagIds([doc]))).map(
        ([name, id]) => [id, name],
      ),
    );
    const detail = this.projectDetail(doc, fieldIdToName, tagIdToName);
    if (options.withTypeFields !== false) {
      const row = await this.typeFields.get(docId);
      detail.type_fields =
        row !== null && Object.keys(row.fields).length > 0 ? row.fields : null;
    }
    return detail;
  }

  async applyFieldUpdate(docId: number, update: InboxFieldUpdate): Promise<InboxDetail> {
    const populated = populatedFields(update);
    if (Object.keys(populated).length > 0) {
      const gateway = this.gateway();
      const doc = await gateway.getDocument(docId);
      await gateway.patchDocumentCustomFields(docId, populated, { prefetchedDoc: doc });
    }
    return this.getDetail(docId);
  }

  async approve(docId: number, update?: InboxFieldUpdate | null): Promise<InboxDetail> {
    const gateway = this.gateway();
    const populated = populatedFields(update);
    if (Object.keys(populated).length > 0) {
      const doc = await gateway.getDocument(docId);
      await gateway.patchDocumentCustomFields(docId, populated, { prefetchedDoc: doc });
    }
    await gateway.swapLifecycleTag(docId, {
      remove: [PENDING_TAG, LOW_CONFIDENCE_TAG],
      add: [APPROVED_TAG],
    });
    await this.autoTagger.ping(docId, { trigger: "propagate", timeoutMs: 2_000 });
    return this.getDetail(docId);
  }

  async reject(docId: number): Promise<InboxDetail> {
    await this.gateway().swapLifecycleTag(docId, {
      remove: [PENDING_TAG, LOW_CONFIDENCE_TAG],
      add: [REJECTED_TAG],
    });
    return this.getDetail(docId);
  }

  async openPreview(docId: number): Promise<Response> {
    return this.gateway().openDocumentStream(docId, "preview");
  }

  private projectItem(
    doc: PaperlessDocument,
    fieldIdToName: Map<number, string>,
    lowConfId: number | null,
  ): InboxItem {
    const fields = customFieldValues(doc, fieldIdToName);
    const tags = (doc.tags as number[] | undefined) ?? [];
    return {
      id: doc.id,
      title: asString(doc.title) || `Dokument #${doc.id}`,
      original_file_name: asString(doc.original_file_name),
      created: parseDate(doc.created_date ?? doc.created),
      added: parseDate(doc.added),
      ai_correspondent: asString(fields.ai_correspondent),
      ai_document_type: asString(fields.ai_document_type),
      ai_title: asString(fields.ai_title),
      ai_issue_date: asString(fields.ai_issue_date),
      ai_confidence: asNumber(fields.ai_confidence),
      low_confidence: lowConfId !== null && tags.includes(lowConfId),
      ai_error_message: asString(fields.ai_error_message),
    };
  }

  private projectDetail(
    doc: PaperlessDocument,
    fieldIdToName: Map<number, string>,
    tagIdToName: Map<number, string>,
  ): InboxDetail {
    const fields = customFieldValues(doc, fieldIdToName);
    const tagNames = ((doc.tags as number[] | undefined) ?? [])
      .map((tid) => tagIdToName.get(tid))
      .filter((name): name is string => name !== undefined && name !== "");
    const content = asString(doc.content) ?? "";
    return {
      id: doc.id,
      title: asString(doc.title) || `Dokument #${doc.id}`,
      original_file_name: asString(doc.original_file_name),
      created: parseDate(doc.created_date ?? doc.created),
      added: parseDate(doc.added),
      ai_correspondent: asString(fields.ai_correspondent),
      ai_document_type: asString(fields.ai_document_type),
      ai_title: asString(fields.ai_title),
      ai_issue_date: asString(fields.ai_issue_date),
      ai_reference_numbers: asString(fields.ai_reference_numbers),
      ai_suggested_tags: asString(fields.ai_suggested_tags),
      ai_summary_de: asString(fields.ai_summary_de),
      ai_confidence: asNumber(fields.ai_confidence),
      ai_backend: asString(fields.ai_backend),
      ai_model: asString(fields.ai_model),
      ai_confidence_reason: asString(fields.ai_confidence_reason),
      ai_error_message: asString(fields.ai_error_message),
      low_confidence: tagNames.includes(LOW_CONFIDENCE_TAG),
      tags: tagNames,
      content_excerpt: content.slice(0, CONTENT_EXCERPT_LIMIT),
      type_fields: null,
    };
  }
}
