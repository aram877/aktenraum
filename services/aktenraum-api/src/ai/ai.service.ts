import { LIFECYCLE_TAGS, logger, TYPE_FIELD_SCHEMA, type LLMBackend } from "@aktenraum/core";
import { Inject, Injectable } from "@nestjs/common";
import { SETTINGS, type Settings } from "../config/settings.js";
import { MemberGateways } from "../tenancy/member-gateways.js";
import type { Principal } from "../auth/principal.js";

import type { MemberPrincipal } from "../auth/principal.js";
import type { PaperlessDocument, PaperlessGateway } from "../paperless/paperless.gateway.js";
import { collectTagIds } from "../paperless/tag-ids.js";
import { RETRIEVAL_DEPS } from "./retrieval.module.js";
import { SharesService } from "../shares/shares.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { TypeFieldsService, type DocumentTypeFieldsRow } from "../type-fields/type-fields.service.js";
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
import { parseQuestion, type ParsedQuestion } from "./question-parser.js";
import { filterToPaperlessParams, projectResults } from "./translate.js";

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

/** Number of reranked chunks whose documents take the first prompt slots. */
const SEMANTIC_SLOTS = 5;
/** Newest structured hits placed first when the question asks for "the latest …". */
const NEWEST_SLOTS = 3;
/** Paperless full-text hits added after the semantic and structured candidates. */
const FULL_TEXT_PAGE_SIZE = 10;
/** Words of the stop-word-stripped question sent to Paperless full-text search. */
const FULL_TEXT_MAX_WORDS = 8;

/** Prompt slot order (fast-ask D1): semantic (≤ 5), then structured, then full-text; de-duplicated, capped. */
export function mergeCandidateIds(input: {
  semantic: readonly number[];
  structured: readonly number[];
  fullText: readonly number[];
  /** "letzte …" questions: the newest structured hits come before the semantic ones. */
  newestFirst?: boolean;
  limit?: number;
}): number[] {
  const limit = input.limit ?? ANSWER_CONTEXT_SIZE;
  const out: number[] = [];
  const seen = new Set<number>();
  const add = (ids: readonly number[], cap: number): void => {
    let added = 0;
    for (const id of ids) {
      if (out.length >= limit || added >= cap) return;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      added++;
    }
  };
  if (input.newestFirst === true) add(input.structured, NEWEST_SLOTS);
  add(input.semantic, SEMANTIC_SLOTS);
  add(input.structured, limit);
  add(input.fullText, limit);
  return out;
}

export function typeSpecificFieldsOf(
  documentType: string | null,
  row: DocumentTypeFieldsRow | null | undefined,
): TypeSpecificField[] {
  const docType = parseDocumentType(documentType);
  if (docType === null) return [];
  const schema = TYPE_FIELD_SCHEMA[docType];
  if (schema.length === 0 || row === null || row === undefined) return [];
  const labelByName = new Map(schema.map((field) => [field.name, field.labelDe]));
  const out: TypeSpecificField[] = [];
  for (const [name, value] of Object.entries(row.fields)) {
    if (value === null || value === undefined || value === "") continue;
    out.push({ name, label: labelByName.get(name) ?? name, value });
  }
  return out;
}

export interface StructuredResult {
  docs: PaperlessDocument[];
  total: number;
}

export interface LoadedCandidates {
  summaries: DocumentSummary[];
  candidates: AnswerCandidate[];
}

function invertNameMap(byName: Record<string, number>): Map<number, string> {
  return new Map(Object.entries(byName).map(([name, id]) => [id, name]));
}

@Injectable()
export class AiService {
  constructor(
    private readonly gateways: MemberGateways,
    private readonly typeFields: TypeFieldsService,
    @Inject(RETRIEVAL_DEPS) private readonly retrievalDeps: RetrievalDeps | null,
    private readonly tenancy: TenancyService,
    private readonly shares: SharesService,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  /** Ends the member's due shares before retrieval, so Ask never answers from an expired one. */
  async expireSharesFor(principal: Principal): Promise<void> {
    if (principal.kind === "member") await this.shares.expireDue(principal.memberId);
  }

  /** Audits `ask` for every cited document the member reads through a share (best effort). */
  async auditSharedCitations(principal: Principal, citations: readonly { id: number }[]): Promise<void> {
    if (principal.kind !== "member" || citations.length === 0) return;
    try {
      const labels = await this.tenancy.documentLabels(principal.memberId, citations.map((c) => c.id));
      for (const [docId, label] of labels) {
        if (label.sharedBy !== null) await this.tenancy.recordShareAccess(docId, principal.memberId, "ask");
      }
    } catch (error: unknown) {
      logger.warn("share_audit_failed", { kind: "ask", error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Whether the cross-encoder rerank runs (false: `RERANKER_ENABLED=false` or RAG off). */
  rerankerEnabled(): boolean {
    return this.retrievalDeps?.reranker != null;
  }

  /** The member's own Paperless gateway (service gateway for the worker). */
  gateway(principal: Principal): Promise<PaperlessGateway> {
    return this.gateways.forPrincipal(principal);
  }

  async promptContext(principal: Principal): Promise<{ correspondents: string[]; tags: string[] }> {
    const gateway = await this.gateway(principal);
    const correspondents = Object.keys(await gateway.listCorrespondents());
    const tags = userTagVocabulary(await gateway.listTags());
    return { correspondents, tags };
  }

  async resolveFilter(
    principal: Principal,
    body: AskRequest,
    llm: LLMBackend,
    buildMessages: (
      query: string,
      options: { correspondents: string[]; tags: string[] },
    ) => { role: "system" | "user" | "assistant"; content: string }[],
    filterSchema: Parameters<LLMBackend["complete"]>[1],
  ): Promise<SearchFilter> {
    if (body.filter !== null && body.filter !== undefined) return body.filter;
    const context = await this.promptContext(principal);
    const messages = buildMessages(body.query as string, context);
    return (await llm.complete(messages, filterSchema)) as SearchFilter;
  }

  async executeFilter(principal: Principal, filter: SearchFilter): Promise<[DocumentSummary[], number]> {
    const gateway = await this.gateway(principal);
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

  /** Deterministic question parsing (no LLM); the correspondent list comes from the 5-minute entity cache. */
  async parseQuestionFor(principal: Principal, question: string): Promise<ParsedQuestion> {
    let known: string[] = [];
    try {
      known = Object.keys(await (await this.gateway(principal)).listCorrespondents());
    } catch (error: unknown) {
      logger.warn("ask_parse_correspondents_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return parseQuestion(question, { correspondents: known, now: new Date() });
  }

  /** The parsed hints in the shape of `meta.filter` (what the SPA shows). */
  parsedToFilter(parsed: ParsedQuestion): SearchFilter {
    return {
      ...EMPTY_FILTER,
      document_type: (parsed.docTypes[0] ?? null) as SearchFilter["document_type"],
      correspondent: parsed.correspondents[0] ?? null,
      date_from: parsed.dateFrom,
      date_to: parsed.dateTo,
      text: parsed.text || null,
      tags: [],
    };
  }

  /**
   * Semantic path: embed, Qdrant (tenancy-scoped), rerank. Parsed hints never narrow it. Any failure
   * (embedder, vector store, tenancy lookup) yields no chunks so the other paths still answer.
   */
  async retrieveChunks(question: string, principal: MemberPrincipal): Promise<RetrievedChunk[]> {
    if (this.retrievalDeps === null) return [];
    try {
      const access = await this.tenancy.searchAccess(principal);
      return await retrieveChunksForQuestion(question, {
        deps: this.retrievalDeps,
        access,
        fetchTopK: this.settings.RERANK_CANDIDATES,
      });
    } catch (error: unknown) {
      logger.warn("ask_semantic_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /** Full-text path: Paperless ranks documents matching any of the question's content words. */
  async fullTextSearch(principal: Principal, parsed: ParsedQuestion): Promise<PaperlessDocument[]> {
    const words = parsed.text.split(" ").filter((word) => word !== "").slice(0, FULL_TEXT_MAX_WORDS);
    if (words.length === 0) return [];
    try {
      const gateway = await this.gateway(principal);
      const payload = await gateway.searchDocuments({
        query: words.join(" OR "),
        page_size: FULL_TEXT_PAGE_SIZE,
      });
      return (payload.results as PaperlessDocument[] | undefined) ?? [];
    } catch (error: unknown) {
      logger.warn("ask_fulltext_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Structured path: only with parsed hints. Newest first, so "meine letzte Gehaltsabrechnung" puts the
   * latest one in the first structured slot, and aggregation questions see every bill of the year.
   */
  async structuredSearch(principal: Principal, parsed: ParsedQuestion): Promise<StructuredResult | null> {
    if (
      parsed.dateFrom === null &&
      parsed.dateTo === null &&
      parsed.docTypes.length === 0 &&
      parsed.correspondents.length === 0
    ) {
      return null;
    }
    try {
      const gateway = await this.gateway(principal);
      const params: Record<string, string | number> = {
        ordering: "-created",
        page_size: ANSWER_CONTEXT_SIZE,
      };
      let constrained = false;
      if (parsed.docTypes.length > 0) {
        const byName = await gateway.listDocumentTypes();
        const ids = parsed.docTypes.flatMap((name) => byName[name] ?? []);
        if (ids.length > 0) {
          params.document_type__id__in = ids.join(",");
          constrained = true;
        }
      }
      if (parsed.correspondents.length > 0) {
        const byName = await gateway.listCorrespondents();
        const ids = parsed.correspondents.flatMap((name) => byName[name] ?? []);
        if (ids.length > 0) {
          params.correspondent__id__in = ids.join(",");
          constrained = true;
        }
      }
      if (parsed.dateFrom !== null) {
        params.created__date__gte = parsed.dateFrom;
        constrained = true;
      }
      if (parsed.dateTo !== null) {
        params.created__date__lte = parsed.dateTo;
        constrained = true;
      }
      // A hint that matches nothing in Paperless must not turn into "the newest 15 documents".
      if (!constrained) return null;
      const payload = await gateway.searchDocuments(params);
      const docs = (payload.results as PaperlessDocument[] | undefined) ?? [];
      return { docs, total: typeof payload.count === "number" ? payload.count : docs.length };
    } catch (error: unknown) {
      logger.warn("ask_structured_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Turns the three paths into the prompt candidates with at most two Paperless-side calls: one `id__in`
   * list for semantic-only hits (name maps are cached), plus one type-fields query. Rows from the
   * structured and full-text paths are already complete.
   */
  async loadCandidates(
    principal: Principal,
    input: {
      chunks: readonly RetrievedChunk[];
      structured: readonly PaperlessDocument[];
      fullText: readonly PaperlessDocument[];
      newestFirst?: boolean;
    },
  ): Promise<LoadedCandidates> {
    const gateway = await this.gateway(principal);
    const rows = new Map<number, PaperlessDocument>();
    for (const doc of [...input.structured, ...input.fullText]) rows.set(doc.id, doc);

    const ids = mergeCandidateIds({
      semantic: rankedUniqueDocIds([...input.chunks]),
      structured: input.structured.map((doc) => doc.id),
      fullText: input.fullText.map((doc) => doc.id),
      newestFirst: input.newestFirst,
    });
    const missing = ids.filter((id) => !rows.has(id));
    if (missing.length > 0) {
      try {
        const payload = await gateway.searchDocuments({
          id__in: missing.join(","),
          page_size: missing.length,
        });
        for (const doc of (payload.results as PaperlessDocument[] | undefined) ?? []) rows.set(doc.id, doc);
      } catch (error: unknown) {
        logger.warn("ask_load_candidates_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const docs = ids.flatMap((id) => rows.get(id) ?? []);
    if (docs.length === 0) return { summaries: [], candidates: [] };

    const [correspondents, documentTypes, tags, fieldIds] = await Promise.all([
      gateway.listCorrespondents(),
      gateway.listDocumentTypes(),
      gateway.listTags(),
      gateway.getCustomFieldIds(),
    ]);
    const summaries = projectResults(docs, {
      correspondentById: invertNameMap(correspondents),
      documentTypeById: invertNameMap(documentTypes),
      tagNameById: invertNameMap(tags),
      lifecycleTagNames: LIFECYCLE_BADGE_NAMES,
      errorFieldId: fieldIds.ai_error_message ?? null,
    });

    let typeRows = new Map<number, DocumentTypeFieldsRow>();
    try {
      typeRows = await this.typeFields.getMany(docs.map((doc) => doc.id));
    } catch (error: unknown) {
      logger.warn("answer_enrich_type_fields_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const fieldNameById = invertNameMap(fieldIds);
    const candidates = summaries.map((summary, index): AnswerCandidate => {
      const ai: Record<string, unknown> = {};
      const customFields =
        (docs[index]?.custom_fields as { field: number; value: unknown }[] | undefined) ?? [];
      for (const cf of customFields) {
        const name = fieldNameById.get(cf.field);
        if (name !== undefined) ai[name] = cf.value;
      }
      return {
        id: summary.id,
        title: summary.title,
        correspondent: summary.correspondent,
        document_type: summary.document_type,
        created: summary.created,
        ai_summary_de: typeof ai.ai_summary_de === "string" ? ai.ai_summary_de : null,
        ai_issue_date: typeof ai.ai_issue_date === "string" ? ai.ai_issue_date : null,
        ai_reference_numbers:
          typeof ai.ai_reference_numbers === "string" ? ai.ai_reference_numbers : null,
        type_specific_fields: typeSpecificFieldsOf(summary.document_type, typeRows.get(summary.id)),
      };
    });
    return { summaries, candidates };
  }

  emptyFilter(): SearchFilter {
    return { ...EMPTY_FILTER, tags: [] };
  }
}
