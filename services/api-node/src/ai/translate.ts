import type { PaperlessDocument, QueryParams } from "../paperless/paperless.gateway.js";
import type { DocumentSummary, SearchFilter } from "./ai.schemas.js";

export function filterToPaperlessParams(
  filter: SearchFilter,
  options: {
    correspondentId: number | null;
    documentTypeId: number | null;
    tagIds?: number[] | null;
  },
): QueryParams {
  const params: QueryParams = {};
  if (options.documentTypeId !== null) params.document_type__id = options.documentTypeId;
  if (options.correspondentId !== null) params.correspondent__id = options.correspondentId;
  if (filter.date_from !== null) params.created__date__gte = filter.date_from;
  if (filter.date_to !== null) params.created__date__lte = filter.date_to;
  if (filter.text) params.query = filter.text;
  if (options.tagIds && options.tagIds.length > 0) {
    params.tags__id__all = options.tagIds.join(",");
  }
  return params;
}

export function parseDateField(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 10) return null;
  const candidate = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : candidate;
}

export function projectResults(
  results: PaperlessDocument[],
  options: {
    correspondentById: Map<number, string>;
    documentTypeById: Map<number, string>;
    tagNameById?: Map<number, string> | null;
    lifecycleTagNames?: ReadonlySet<string> | null;
    errorFieldId?: number | null;
  },
): DocumentSummary[] {
  const out: DocumentSummary[] = [];
  for (const doc of results) {
    const lifecycle: string[] = [];
    const userTags: string[] = [];
    if (options.tagNameById) {
      for (const tid of (doc.tags as number[] | undefined) ?? []) {
        const name = options.tagNameById.get(tid);
        if (name === undefined || name === "") continue;
        if (options.lifecycleTagNames?.has(name)) lifecycle.push(name);
        else userTags.push(name);
      }
    }

    let errorMessage: string | null = null;
    if (options.errorFieldId !== null && options.errorFieldId !== undefined) {
      for (const cf of (doc.custom_fields as { field: number; value: unknown }[] | undefined) ??
        []) {
        if (cf.field === options.errorFieldId) {
          errorMessage = typeof cf.value === "string" && cf.value !== "" ? cf.value : null;
          break;
        }
      }
    }

    const correspondentId = doc.correspondent;
    const documentTypeId = doc.document_type;
    out.push({
      id: doc.id,
      title: (typeof doc.title === "string" && doc.title) || `Dokument #${doc.id}`,
      original_file_name:
        typeof doc.original_file_name === "string" ? doc.original_file_name : null,
      correspondent:
        typeof correspondentId === "number"
          ? (options.correspondentById.get(correspondentId) ?? null)
          : null,
      document_type:
        typeof documentTypeId === "number"
          ? (options.documentTypeById.get(documentTypeId) ?? null)
          : null,
      created: parseDateField(doc.created_date ?? doc.created),
      lifecycle_tags: lifecycle,
      tags: userTags,
      ai_error_message: errorMessage,
    });
  }
  return out;
}
