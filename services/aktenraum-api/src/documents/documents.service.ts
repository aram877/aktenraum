import { findDuplicates, LIFECYCLE_TAGS, logger, type DocFields } from "@aktenraum/core";
import { Injectable } from "@nestjs/common";

import { AutoTaggerClient } from "../auto-tagger/auto-tagger.client.js";
import type { PaperlessDocument, PaperlessGateway } from "../paperless/paperless.gateway.js";
import { PaperlessGatewayProvider } from "../paperless/paperless.module.js";
import { collectTagIds } from "../paperless/tag-ids.js";

export const REPROCESS_REMOVE: string[] = [
  ...LIFECYCLE_TAGS,
  "ai-low-confidence",
  "ai-auto-approved",
];

export const BADGE_TAG_NAMES: ReadonlySet<string> = new Set([
  ...LIFECYCLE_TAGS,
  "ai-low-confidence",
  "ai-auto-approved",
]);

const IN_FLIGHT_TAGS = ["ai-pending", "ai-approved"] as const;
const IN_FLIGHT_CACHE_TTL_SECONDS = 5;

export interface ReprocessResponse {
  doc_id: number;
  cleared_tags: string[];
  auto_tagger_notified: boolean;
}

export interface DocIdResponse {
  doc_id: number;
}

export interface InFlightCount {
  count: number;
}

export interface ProcessingStateResponse {
  processing: number[];
  slots: Record<string, unknown>;
}

export interface TaskStatusResponse {
  task_id: string;
  status: string;
  doc_id?: number | null;
  result?: string | null;
}

export interface DocumentStatusResponse {
  id: number;
  lifecycle_tags: string[];
}

const EMPTY_SLOTS = { extraction: null, propagation: null, indexer: null };

const DUPLICATE_CANDIDATE_CAP = 200;

export function projectDocFields(
  doc: PaperlessDocument,
  fieldIdToName: Map<number, string>,
): DocFields {
  const values: Record<string, string> = {};
  for (const entry of (doc.custom_fields as { field: number; value: unknown }[] | undefined) ??
    []) {
    const name = fieldIdToName.get(entry.field);
    if (name === undefined) continue;
    const value = entry.value;
    if (typeof value === "string") values[name] = value;
    else if (value !== null && value !== undefined) values[name] = String(value);
  }
  return {
    id: doc.id,
    correspondent: values.ai_correspondent ?? null,
    issueDate: values.ai_issue_date ?? null,
    monetaryAmount: values.ai_monetary_amount ?? null,
    referenceNumbers: values.ai_reference_numbers ?? null,
    documentType: values.ai_document_type ?? null,
  };
}

export function extractDocId(taskRow: Record<string, unknown>): number | null {
  const related = taskRow.related_document;
  if (typeof related === "number") return related;
  const status = String(taskRow.status ?? "").toUpperCase();
  if (status !== "SUCCESS") return null;
  const result = typeof taskRow.result === "string" ? taskRow.result : "";
  const match = /document id (\d+)/.exec(result);
  if (match === null) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) ? parsed : null;
}

@Injectable()
export class DocumentsService {
  private inFlightCache: { when: number; count: number } | null = null;

  constructor(
    private readonly gatewayProvider: PaperlessGatewayProvider,
    private readonly autoTagger: AutoTaggerClient,
  ) {}

  private gateway(): PaperlessGateway {
    return this.gatewayProvider.require();
  }

  async openStream(docId: number, kind: "preview" | "download" | "thumb"): Promise<Response> {
    return this.gateway().openDocumentStream(docId, kind);
  }

  async reprocess(docId: number): Promise<ReprocessResponse> {
    await this.gateway().swapLifecycleTag(docId, { remove: REPROCESS_REMOVE, add: [] });
    const notified = await this.autoTagger.ping(docId, { trigger: "extract" });
    return { doc_id: docId, cleared_tags: REPROCESS_REMOVE, auto_tagger_notified: notified };
  }

  async dismissDuplicate(docId: number): Promise<DocIdResponse> {
    const gateway = this.gateway();
    await gateway.ensureTag("ai-duplicate-dismissed");
    await gateway.swapLifecycleTag(docId, {
      remove: ["ai-duplicate"],
      add: ["ai-duplicate-dismissed"],
    });
    return { doc_id: docId };
  }

  async star(docId: number): Promise<DocIdResponse> {
    const gateway = this.gateway();
    await gateway.ensureTag("wichtig");
    await gateway.swapLifecycleTag(docId, { remove: [], add: ["wichtig"] });
    await this.autoTagger.ping(docId, { trigger: "reindex-metadata" });
    return { doc_id: docId };
  }

  async unstar(docId: number): Promise<DocIdResponse> {
    await this.gateway().swapLifecycleTag(docId, { remove: ["wichtig"], add: [] });
    await this.autoTagger.ping(docId, { trigger: "reindex-metadata" });
    return { doc_id: docId };
  }

  async processingState(): Promise<ProcessingStateResponse> {
    const body = await this.autoTagger.fetchProcessingState();
    if (body === null) return { processing: [], slots: { ...EMPTY_SLOTS } };
    return {
      processing: (body.processing ?? [])
        .map((raw) => Number(raw))
        .filter((id) => Number.isInteger(id)),
      slots: body.slots ?? { ...EMPTY_SLOTS },
    };
  }

  async inFlightCount(): Promise<InFlightCount> {
    const now = Date.now() / 1000;
    const cached = this.inFlightCache;
    if (cached !== null && now - cached.when <= IN_FLIGHT_CACHE_TTL_SECONDS) {
      return { count: cached.count };
    }
    const gateway = this.gateway();
    const tags = await gateway.listTags();
    const flightIds = IN_FLIGHT_TAGS.map((name) => tags[name]).filter(
      (id): id is number => id !== undefined,
    );
    if (flightIds.length === 0) {
      this.inFlightCache = { when: now, count: 0 };
      return { count: 0 };
    }
    const payload = await gateway.searchDocuments(
      { tags__id__in: flightIds.join(",") },
      { pageSize: 1 },
    );
    const count = typeof payload.count === "number" ? payload.count : 0;
    this.inFlightCache = { when: Date.now() / 1000, count };
    return { count };
  }

  async taskStatus(taskId: string): Promise<TaskStatusResponse> {
    const payload = await this.gateway().getTasks(taskId);
    const rows = Array.isArray(payload) ? (payload as Record<string, unknown>[]) : [];
    const row = rows[0];
    if (row === undefined) return { task_id: taskId, status: "UNKNOWN" };
    return {
      task_id: taskId,
      status: String(row.status ?? "UNKNOWN").toUpperCase(),
      doc_id: extractDocId(row),
      result: typeof row.result === "string" ? row.result : null,
    };
  }

  async documentStatus(docId: number): Promise<DocumentStatusResponse> {
    const gateway = this.gateway();
    const doc: PaperlessDocument = await gateway.getDocument(docId);
    const tags = await gateway.listTagsCovering(collectTagIds([doc]));
    const tagIdToName = new Map(Object.entries(tags).map(([name, id]) => [id, name]));
    const lifecycle: string[] = [];
    for (const tid of (doc.tags as number[] | undefined) ?? []) {
      const name = tagIdToName.get(tid);
      if (name !== undefined && BADGE_TAG_NAMES.has(name)) lifecycle.push(name);
    }
    return { id: docId, lifecycle_tags: lifecycle };
  }

  async duplicateCandidates(docId: number): Promise<{
    doc_id: number;
    rawCandidates: PaperlessDocument[];
    matchedIds: Set<number>;
    fieldIdToName: Map<number, string>;
  }> {
    const gateway = this.gateway();
    const target = await gateway.getDocument(docId);
    const tags = await gateway.listTags();
    const propagatedId = tags["ai-propagated"];
    const dismissedId = tags["ai-duplicate-dismissed"];
    const empty = {
      doc_id: docId,
      rawCandidates: [] as PaperlessDocument[],
      matchedIds: new Set<number>(),
      fieldIdToName: new Map<number, string>(),
    };
    if (propagatedId === undefined) return empty;

    const targetTagIds = new Set((target.tags as number[] | undefined) ?? []);
    if (dismissedId !== undefined && targetTagIds.has(dismissedId)) return empty;

    const correspondentId = target.correspondent;
    if (typeof correspondentId !== "number") return empty;

    const fieldIds = await gateway.getCustomFieldIds();
    const fieldIdToName = new Map(Object.entries(fieldIds).map(([n, i]) => [i, n]));
    const targetFields = projectDocFields(target, fieldIdToName);
    if (!targetFields.correspondent || !targetFields.issueDate) return empty;

    const payload = await gateway.searchDocuments(
      { tags__id__all: String(propagatedId), correspondent__id: String(correspondentId) },
      { pageSize: DUPLICATE_CANDIDATE_CAP },
    );
    const rawCandidates = ((payload.results as PaperlessDocument[] | undefined) ?? []).filter(
      (c) =>
        c.id !== docId &&
        (dismissedId === undefined ||
          !((c.tags as number[] | undefined) ?? []).includes(dismissedId)),
    );
    if (rawCandidates.length === 0) return { ...empty, fieldIdToName };

    const matchedIds = new Set(
      findDuplicates(
        targetFields,
        rawCandidates.map((c) => projectDocFields(c, fieldIdToName)),
      ),
    );
    return { doc_id: docId, rawCandidates, matchedIds, fieldIdToName };
  }

  logUnavailable(event: string, error: unknown): void {
    logger.info(event, { error: error instanceof Error ? error.message : String(error) });
  }
}
