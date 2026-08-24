import { LIFECYCLE_TAGS } from "@aktenraum/core";
import { Injectable } from "@nestjs/common";

import { AutoTaggerClient } from "../auto-tagger/auto-tagger.client.js";
import { customFieldValues, parseDate } from "../inbox/inbox.service.js";
import type { PaperlessDocument, PaperlessGateway, QueryParams } from "../paperless/paperless.gateway.js";
import { PaperlessGatewayProvider } from "../paperless/paperless.module.js";
import { collectTagIds } from "../paperless/tag-ids.js";
import type { LibraryItem, LibraryList, TagFacetList } from "./library.schemas.js";

const BADGE_TAGS: ReadonlySet<string> = new Set([
  ...LIFECYCLE_TAGS.filter((name) => name !== "ai-pending"),
  "ai-auto-approved",
  "ai-duplicate",
]);

const INTERNAL_TAGS: ReadonlySet<string> = new Set([
  ...LIFECYCLE_TAGS,
  "ai-low-confidence",
  "ai-auto-approved",
]);

const FACET_SAMPLE_SIZE = 500;
const FACET_MIN_COUNT = 2;

export interface LibraryQuery {
  documentType?: string;
  correspondent?: string;
  dateFrom?: string;
  dateTo?: string;
  text?: string;
  tags?: string[];
  page: number;
  pageSize: number;
  ordering: string;
}

export function resolveTagIds(
  requested: string[] | undefined,
  nameToId: Record<string, number>,
): number[] {
  if (requested === undefined || requested.length === 0) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const name of requested) {
    const clean = name.trim();
    if (clean === "") continue;
    const tid = nameToId[clean];
    if (tid === undefined || seen.has(tid)) continue;
    out.push(tid);
    seen.add(tid);
  }
  return out;
}

function invert(mapping: Record<string, number>): Map<number, string> {
  return new Map(Object.entries(mapping).map(([name, id]) => [id, name]));
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

@Injectable()
export class LibraryService {
  constructor(
    private readonly gatewayProvider: PaperlessGatewayProvider,
    private readonly autoTagger: AutoTaggerClient,
  ) {}

  private gateway(): PaperlessGateway {
    return this.gatewayProvider.require();
  }

  async listLibrary(query: LibraryQuery): Promise<LibraryList> {
    const gateway = this.gateway();
    const correspondents = await gateway.listCorrespondents();
    const documentTypes = await gateway.listDocumentTypes();
    const tagNameToId = await gateway.listTags();
    const pendingId = tagNameToId["ai-pending"];

    let text = query.text;
    const params: QueryParams = { ordering: query.ordering, page: query.page };

    if (query.documentType) {
      const dtId = documentTypes[query.documentType];
      if (dtId !== undefined) params.document_type__id = dtId;
    }
    if (query.correspondent) {
      const cId = correspondents[query.correspondent];
      if (cId !== undefined) {
        params.correspondent__id = cId;
      } else {
        text = (text ? `${text} ` : "") + query.correspondent;
      }
    }
    if (query.dateFrom !== undefined) params.created__date__gte = query.dateFrom;
    if (query.dateTo !== undefined) params.created__date__lte = query.dateTo;
    if (text) params.query = text;
    if (pendingId !== undefined) params.tags__id__none = pendingId;

    const requestedTagIds = resolveTagIds(query.tags, tagNameToId);
    const requestedNonEmpty = (query.tags ?? []).filter((t) => t.trim() !== "");
    if (requestedNonEmpty.length > 0 && requestedTagIds.length < requestedNonEmpty.length) {
      return { results: [], total: 0, page: query.page, page_size: query.pageSize };
    }
    if (requestedTagIds.length > 0) {
      params.tags__id__all = requestedTagIds.join(",");
    }

    const payload = await gateway.searchDocuments(params, { pageSize: query.pageSize });
    const rawResults = (payload.results as PaperlessDocument[] | undefined) ?? [];
    const totalNative =
      typeof payload.count === "number" ? payload.count : rawResults.length;

    const correspondentById = invert(correspondents);
    const documentTypeById = invert(documentTypes);
    const tagNameById = invert(await gateway.listTagsCovering(collectTagIds(rawResults)));
    const fieldIdToName = invert(await gateway.getCustomFieldIds());

    let items = rawResults.map((doc) =>
      this.project(doc, correspondentById, documentTypeById, tagNameById, fieldIdToName),
    );

    if (query.page === 1) {
      const inFlightIds = await this.fetchInFlightIds();
      if (inFlightIds.length > 0) {
        const pinnedRows: LibraryItem[] = [];
        for (const docId of inFlightIds) {
          const row = await this.projectInFlightRow(
            gateway,
            docId,
            correspondentById,
            documentTypeById,
            tagNameById,
            fieldIdToName,
          );
          if (row !== null) pinnedRows.push(row);
        }
        if (pinnedRows.length > 0) {
          const pinnedIds = new Set(pinnedRows.map((row) => row.id));
          items = [...pinnedRows, ...items.filter((item) => !pinnedIds.has(item.id))];
        }
      }
    }

    return { results: items, total: totalNative, page: query.page, page_size: query.pageSize };
  }

  async listTagFacet(): Promise<TagFacetList> {
    const gateway = this.gateway();
    const tagNameToId = await gateway.listTags();
    const pendingId = tagNameToId["ai-pending"];

    const params: QueryParams = { ordering: "-created" };
    if (pendingId !== undefined) params.tags__id__none = pendingId;

    const payload = await gateway.searchDocuments(params, { pageSize: FACET_SAMPLE_SIZE });
    const rawResults = (payload.results as PaperlessDocument[] | undefined) ?? [];
    const tagNameById = invert(await gateway.listTagsCovering(collectTagIds(rawResults)));

    const counter = new Map<string, number>();
    for (const doc of rawResults) {
      for (const tid of (doc.tags as number[] | undefined) ?? []) {
        const name = tagNameById.get(tid);
        if (name === undefined || name === "" || INTERNAL_TAGS.has(name)) continue;
        counter.set(name, (counter.get(name) ?? 0) + 1);
      }
    }

    const results = [...counter.entries()]
      .filter(([, count]) => count >= FACET_MIN_COUNT)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
    return { results };
  }

  private async fetchInFlightIds(): Promise<number[]> {
    const body = await this.autoTagger.fetchProcessingState();
    if (body === null) return [];
    const seen = new Set<number>();
    const ordered: number[] = [];
    for (const raw of body.processing ?? []) {
      const docId = Number(raw);
      if (!Number.isInteger(docId) || seen.has(docId)) continue;
      seen.add(docId);
      ordered.push(docId);
    }
    return ordered;
  }

  private async projectInFlightRow(
    gateway: PaperlessGateway,
    docId: number,
    correspondentById: Map<number, string>,
    documentTypeById: Map<number, string>,
    tagNameById: Map<number, string>,
    fieldIdToName: Map<number, string>,
  ): Promise<LibraryItem | null> {
    try {
      const doc = await gateway.getDocument(docId);
      const item = this.project(
        doc,
        correspondentById,
        documentTypeById,
        tagNameById,
        fieldIdToName,
      );
      return { ...item, is_processing: true };
    } catch {
      return null;
    }
  }

  private project(
    doc: PaperlessDocument,
    correspondentById: Map<number, string>,
    documentTypeById: Map<number, string>,
    tagNameById: Map<number, string>,
    fieldIdToName: Map<number, string>,
  ): LibraryItem {
    const fields = customFieldValues(doc, fieldIdToName);
    const tagNames = ((doc.tags as number[] | undefined) ?? [])
      .map((tid) => tagNameById.get(tid))
      .filter((name): name is string => name !== undefined && name !== "");

    const correspondentId = doc.correspondent;
    const documentTypeId = doc.document_type;

    return {
      id: doc.id,
      title: asString(doc.title) || `Dokument #${doc.id}`,
      original_file_name: asString(doc.original_file_name),
      created: parseDate(doc.created_date ?? doc.created),
      added: parseDate(doc.added),
      correspondent:
        (typeof correspondentId === "number"
          ? (correspondentById.get(correspondentId) ?? null)
          : null) ?? asString(fields.ai_correspondent),
      document_type:
        (typeof documentTypeId === "number"
          ? (documentTypeById.get(documentTypeId) ?? null)
          : null) ?? asString(fields.ai_document_type),
      lifecycle_tags: tagNames.filter((name) => BADGE_TAGS.has(name)),
      tags: tagNames.filter((name) => !INTERNAL_TAGS.has(name)),
      ai_error_message: asString(fields.ai_error_message),
      is_processing: false,
    };
  }
}
