import { LIFECYCLE_TAGS, logger, TYPE_FIELD_SCHEMA, type LLMBackend } from "@aktenraum/core-ts";
import { Inject, Injectable } from "@nestjs/common";

import type { PaperlessDocument, PaperlessGateway } from "../paperless/paperless.gateway.js";
import { PaperlessGatewayProvider } from "../paperless/paperless.module.js";
import { collectTagIds } from "../paperless/tag-ids.js";
import { RETRIEVAL_DEPS } from "./retrieval.module.js";
import { TypeFieldsService } from "../type-fields/type-fields.service.js";
import {
  EMPTY_FILTER,
  type AnswerCandidate,
  type AskRequest,
  type DocumentSummary,
  type SearchFilter,
  type TypeSpecificField,
} from "./ai.schemas.js";
import { parseDocumentType } from "./prompt-modules.js";
import { retrieveChunksForQuestion, type RetrievalDeps, type RetrievedChunk } from "./retrieval.js";
import { filterToPaperlessParams, parseDateField, projectResults } from "./translate.js";

export const NO_MATCH_DE = "Ich habe keine passenden Dokumente gefunden.";

export const ANSWER_LLM_FAILED_DE =
  "Ich konnte die Antwort nicht zuverlässig formulieren. " +
  "Schau bitte direkt in die unten gelisteten Dokumente.";

export const ANSWER_CONTEXT_SIZE = 15;

export const LIFECYCLE_BADGE_NAMES: ReadonlySet<string> = new Set([
  ...LIFECYCLE_TAGS,
  "ai-low-confidence",
  "ai-auto-approved",
]);

const MAX_CHUNKS_PER_DOC_IN_PROMPT = 3;

const CITATION_MARKER_RE = /\[Quelle:\s*(\d+)\s*\]/gi;

const DENIAL_RE = new RegExp(
  "in den (bereitgestellten )?dokumenten nicht (finden|enthalten)" +
    "|nicht in den (bereitgestellten )?dokumenten" +
    "|keine passenden dokumente" +
    "|keines der dokumente (enthält|nennt|beantwortet)",
  "i",
);

const DENIAL_MAX_LEN = 200;

const DEGENERATE_ANSWER_TOKENS: ReadonlySet<string> = new Set([
  "answer_de",
  "answer",
  "answer de",
  "antwort",
  "string",
]);

export function extractInlineCitations(text: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  CITATION_MARKER_RE.lastIndex = 0;
  for (const match of text.matchAll(CITATION_MARKER_RE)) {
    const value = Number(match[1]);
    if (!Number.isInteger(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function isDegenerateAnswer(text: string): boolean {
  if (!text) return true;
  return DEGENERATE_ANSWER_TOKENS.has(text.toLowerCase().replace(/^[ .:]+|[ .:]+$/g, ""));
}

export function isDenialAnswer(text: string): boolean {
  if (!text) return false;
  const stripped = text.trim();
  if (stripped.length > DENIAL_MAX_LEN) return false;
  return DENIAL_RE.test(stripped);
}

export function rankedUniqueDocIds(chunks: RetrievedChunk[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const chunk of chunks) {
    if (seen.has(chunk.docId)) continue;
    seen.add(chunk.docId);
    out.push(chunk.docId);
  }
  return out;
}

export function groupChunksByDoc(chunks: RetrievedChunk[]): Map<number, string[]> {
  const byDoc = new Map<number, string[]>();
  for (const chunk of chunks) {
    let bucket = byDoc.get(chunk.docId);
    if (bucket === undefined) {
      bucket = [];
      byDoc.set(chunk.docId, bucket);
    }
    if (bucket.length < MAX_CHUNKS_PER_DOC_IN_PROMPT) bucket.push(chunk.text);
  }
  return byDoc;
}

export function resolveCitations(
  citedIds: number[],
  results: DocumentSummary[],
): DocumentSummary[] {
  const byId = new Map(results.map((result) => [result.id, result]));
  const out: DocumentSummary[] = [];
  const seen = new Set<number>();
  for (const cid of citedIds) {
    const found = byId.get(cid);
    if (found !== undefined && !seen.has(cid)) {
      out.push(found);
      seen.add(cid);
    }
  }
  return out;
}

export function userTagVocabulary(nameToId: Record<string, number>): string[] {
  const excluded: ReadonlySet<string> = new Set([...LIFECYCLE_TAGS, "ai-low-confidence"]);
  return Object.keys(nameToId).filter((name) => !excluded.has(name));
}

export function broadenForAnswer(filter: SearchFilter): SearchFilter {
  let next = filter;
  if (filter.tags.length > 0) {
    logger.info("ai_answer_tags_stripped", { tags: filter.tags });
    next = { ...next, tags: [] };
  }
  const hasStructural =
    filter.document_type !== null ||
    filter.correspondent !== null ||
    filter.date_from !== null ||
    filter.date_to !== null;
  if (hasStructural && filter.text) {
    next = { ...next, text: null };
  }
  return next;
}

export function docToSummary(doc: PaperlessDocument): DocumentSummary {
  return {
    id: doc.id,
    title: (typeof doc.title === "string" && doc.title) || `Dokument #${doc.id}`,
    original_file_name:
      typeof doc.original_file_name === "string" ? doc.original_file_name : null,
    correspondent: null,
    document_type: null,
    created: parseDateField(doc.created_date ?? doc.created),
    lifecycle_tags: [],
    tags: [],
    ai_error_message: null,
  };
}

@Injectable()
export class AiService {
  constructor(
    private readonly gatewayProvider: PaperlessGatewayProvider,
    private readonly typeFields: TypeFieldsService,
    @Inject(RETRIEVAL_DEPS) private readonly retrievalDeps: RetrievalDeps | null,
  ) {}

  gateway(): PaperlessGateway {
    return this.gatewayProvider.require();
  }

  async promptContext(): Promise<{ correspondents: string[]; tags: string[] }> {
    const gateway = this.gateway();
    const correspondents = Object.keys(await gateway.listCorrespondents());
    const tags = userTagVocabulary(await gateway.listTags());
    return { correspondents, tags };
  }

  async resolveFilter(
    body: AskRequest,
    llm: LLMBackend,
    buildMessages: (
      query: string,
      options: { correspondents: string[]; tags: string[] },
    ) => { role: "system" | "user" | "assistant"; content: string }[],
    filterSchema: Parameters<LLMBackend["complete"]>[1],
  ): Promise<SearchFilter> {
    if (body.filter !== null && body.filter !== undefined) return body.filter;
    const context = await this.promptContext();
    const messages = buildMessages(body.query as string, context);
    return (await llm.complete(messages, filterSchema)) as SearchFilter;
  }

  async executeFilter(filter: SearchFilter): Promise<[DocumentSummary[], number]> {
    const gateway = this.gateway();
    const correspondents = await gateway.listCorrespondents();
    const documentTypes = await gateway.listDocumentTypes();
    const tags = await gateway.listTags();

    const correspondentId = filter.correspondent
      ? (correspondents[filter.correspondent] ?? null)
      : null;
    const documentTypeId = filter.document_type
      ? (documentTypes[filter.document_type] ?? null)
      : null;

    let effective = filter;
    if (filter.correspondent && correspondentId === null) {
      effective = {
        ...filter,
        text: (filter.text ? `${filter.text} ` : "") + filter.correspondent,
      };
    }

    const tagIds: number[] = [];
    for (const name of effective.tags) {
      const tid = tags[name];
      if (tid !== undefined) tagIds.push(tid);
    }

    const params = filterToPaperlessParams(effective, {
      correspondentId,
      documentTypeId,
      tagIds,
    });
    const payload = await gateway.searchDocuments(params);
    const rawResults = (payload.results as PaperlessDocument[] | undefined) ?? [];
    const totalNative =
      typeof payload.count === "number" ? payload.count : rawResults.length;

    const errorFieldId = (await gateway.getCustomFieldIds()).ai_error_message ?? null;
    const tagsCovering = await gateway.listTagsCovering(collectTagIds(rawResults));
    const summaries = projectResults(rawResults, {
      correspondentById: new Map(Object.entries(correspondents).map(([n, i]) => [i, n])),
      documentTypeById: new Map(Object.entries(documentTypes).map(([n, i]) => [i, n])),
      tagNameById: new Map(Object.entries(tagsCovering).map(([n, i]) => [i, n])),
      lifecycleTagNames: LIFECYCLE_BADGE_NAMES,
      errorFieldId,
    });
    return [summaries, totalNative];
  }

  async retrieveChunks(question: string, filter: SearchFilter): Promise<RetrievedChunk[]> {
    if (this.retrievalDeps === null) return [];
    return retrieveChunksForQuestion(question, {
      deps: this.retrievalDeps,
      structuralFilter: filter,
    });
  }

  async enrichWithAiFields(results: DocumentSummary[]): Promise<AnswerCandidate[]> {
    const gateway = this.gateway();
    const fieldIdToName = new Map(
      Object.entries(await gateway.getCustomFieldIds()).map(([name, id]) => [id, name]),
    );
    const enriched: AnswerCandidate[] = [];
    for (const result of results) {
      let doc: PaperlessDocument;
      try {
        doc = await gateway.getDocument(result.id);
      } catch (error: unknown) {
        logger.warn("answer_enrich_failed", {
          doc_id: result.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const ai: Record<string, unknown> = {};
      for (const cf of (doc.custom_fields as { field: number; value: unknown }[] | undefined) ??
        []) {
        const name = fieldIdToName.get(cf.field);
        if (name !== undefined) ai[name] = cf.value;
      }
      enriched.push({
        id: result.id,
        title: result.title,
        correspondent: result.correspondent,
        document_type: result.document_type,
        created: result.created,
        ai_summary_de: typeof ai.ai_summary_de === "string" ? ai.ai_summary_de : null,
        ai_issue_date: typeof ai.ai_issue_date === "string" ? ai.ai_issue_date : null,
        ai_reference_numbers:
          typeof ai.ai_reference_numbers === "string" ? ai.ai_reference_numbers : null,
        type_specific_fields: await this.loadTypeSpecificFields(
          result.id,
          result.document_type,
        ),
      });
    }
    return enriched;
  }

  async loadTypeSpecificFields(
    docId: number,
    documentType: string | null,
  ): Promise<TypeSpecificField[]> {
    const docType = parseDocumentType(documentType);
    if (docType === null) return [];
    const schema = TYPE_FIELD_SCHEMA[docType];
    if (schema.length === 0) return [];
    let row;
    try {
      row = await this.typeFields.get(docId);
    } catch (error: unknown) {
      logger.warn("answer_enrich_type_fields_failed", {
        doc_id: docId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    if (row === null || Object.keys(row.fields).length === 0) return [];
    const labelByName = new Map(schema.map((field) => [field.name, field.labelDe]));
    const out: TypeSpecificField[] = [];
    for (const [name, value] of Object.entries(row.fields)) {
      if (value === null || value === undefined || value === "") continue;
      out.push({ name, label: labelByName.get(name) ?? name, value });
    }
    return out;
  }

  async promotePromptResults(
    structural: DocumentSummary[],
    ragChunks: RetrievedChunk[],
  ): Promise<DocumentSummary[]> {
    const promptResults = structural.slice(0, ANSWER_CONTEXT_SIZE);
    if (ragChunks.length === 0) return promptResults;

    const gateway = this.gateway();
    const structuralIds = new Set(promptResults.map((row) => row.id));
    let remaining = ANSWER_CONTEXT_SIZE - promptResults.length;
    for (const docId of rankedUniqueDocIds(ragChunks)) {
      if (remaining <= 0) break;
      if (structuralIds.has(docId)) continue;
      try {
        const doc = await gateway.getDocument(docId);
        promptResults.push(docToSummary(doc));
        structuralIds.add(docId);
        remaining -= 1;
      } catch {
        logger.warn("rag_doc_summary_fetch_failed", { doc_id: docId });
      }
    }
    return promptResults;
  }

  emptyFilter(): SearchFilter {
    return { ...EMPTY_FILTER, tags: [] };
  }
}
