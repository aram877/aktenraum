import {
  chunkText,
  LIFECYCLE_TAGS,
  logger,
  type Embedder,
  type PaperlessClient,
  type PaperlessDocument,
  type QdrantVectorStore,
} from "@aktenraum/core";

import { formatError } from "./extract.js";

const MAX_CHUNKS_PER_DOC = 200;
export const INDEX_ERROR_TAG = "ai-index-error";

export interface IndexingDeps {
  paperless: PaperlessClient;
  vectorStore: QdrantVectorStore;
  embedder: Embedder;
}

export interface PayloadMeta {
  docType: string | null;
  correspondent: string | null;
  tags: string[];
  createdDate: string | null;
}

/**
 * Resolve tag ids to user-facing names, excluding every lifecycle and
 * auxiliary tag — `ai-propagated` or `ai-index-error` must never end up in
 * the searchable payload.
 */
export function filterUserTags(
  tagIds: readonly number[],
  tagMap: Map<number, string>,
): string[] {
  const excluded = new Set<string>([...LIFECYCLE_TAGS, "ai-low-confidence", INDEX_ERROR_TAG]);
  const out: string[] = [];
  for (const tid of tagIds) {
    const name = tagMap.get(tid);
    if (name !== undefined && name !== "" && !excluded.has(name)) out.push(name);
  }
  return out;
}

export function parseDateOnly(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 10) return null;
  const candidate = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function invert(mapping: Record<number, string>): Map<number, string> {
  return new Map(Object.entries(mapping).map(([id, name]) => [Number(id), name]));
}

export async function resolvePayloadMetadata(
  paperless: PaperlessClient,
  doc: PaperlessDocument,
): Promise<PayloadMeta> {
  let correspondentMap = new Map<number, string>();
  let documentTypeMap = new Map<number, string>();
  let tagMap = new Map<number, string>();
  try {
    correspondentMap = invert(await paperless.getEntityNameMap("/api/correspondents/"));
    documentTypeMap = invert(await paperless.getEntityNameMap("/api/document_types/"));
    tagMap = invert(await paperless.getEntityNameMap("/api/tags/"));
  } catch (error: unknown) {
    logger.warn("indexer_entity_maps_failed", {
      doc_id: doc.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const aiFields = await paperless.getAiCustomFieldValues(doc.id).catch(() => ({}));
  const asText = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;

  const correspondentId = doc.correspondent;
  const documentTypeId = doc.document_type;

  return {
    correspondent:
      (typeof correspondentId === "number" ? (correspondentMap.get(correspondentId) ?? null) : null) ??
      asText((aiFields as Record<string, unknown>).ai_correspondent),
    docType:
      (typeof documentTypeId === "number" ? (documentTypeMap.get(documentTypeId) ?? null) : null) ??
      asText((aiFields as Record<string, unknown>).ai_document_type),
    tags: filterUserTags((doc.tags as number[] | undefined) ?? [], tagMap),
    createdDate:
      parseDateOnly(doc.created_date) ??
      parseDateOnly(doc.created) ??
      parseDateOnly((aiFields as Record<string, unknown>).ai_issue_date),
  };
}

async function clearIndexErrorTagIfPresent(
  paperless: PaperlessClient,
  doc: PaperlessDocument,
): Promise<void> {
  const errorTagId = await paperless.getTagId(INDEX_ERROR_TAG);
  if (errorTagId === null) return;
  const current = (doc.tags as number[] | undefined) ?? [];
  if (!current.includes(errorTagId)) return;
  await paperless.patchDocumentNativeFields(doc.id, {
    tags: current.filter((id) => id !== errorTagId),
  });
}

/**
 * Index one document end to end. Idempotent: the delete-by-doc-id always runs
 * first, so a re-index never leaves stale chunks behind when a document was
 * edited and now produces fewer of them.
 */
export async function indexDocument(docId: number, deps: IndexingDeps): Promise<void> {
  let doc: PaperlessDocument;
  try {
    doc = await deps.paperless.getDocument(docId);
  } catch (error: unknown) {
    logger.warn("indexer_fetch_failed", {
      doc_id: docId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const content = await deps.paperless.getDocumentContent(docId).catch(() => "");
  let chunks = content ? chunkText(content) : [];
  if (chunks.length > MAX_CHUNKS_PER_DOC) {
    logger.warn("indexer_chunks_truncated", {
      doc_id: docId,
      produced: chunks.length,
      kept: MAX_CHUNKS_PER_DOC,
    });
    chunks = chunks.slice(0, MAX_CHUNKS_PER_DOC);
  }

  const meta = await resolvePayloadMetadata(deps.paperless, doc);

  try {
    await deps.vectorStore.deleteByDocId(docId);

    if (chunks.length === 0) {
      logger.info("indexer_no_content", { doc_id: docId, chars: content.length });
      await clearIndexErrorTagIfPresent(deps.paperless, doc);
      return;
    }

    const embeddings = await deps.embedder.embedDense(chunks.map((c) => c.text));
    const written = await deps.vectorStore.upsertChunks(chunks, embeddings, {
      docId,
      docType: meta.docType,
      correspondent: meta.correspondent,
      tags: meta.tags,
      createdDate: meta.createdDate,
    });
    logger.info("indexer_doc_indexed", {
      doc_id: docId,
      chunks_written: written,
      content_chars: content.length,
    });
    await clearIndexErrorTagIfPresent(deps.paperless, doc);
    await deps.paperless.setErrorMessage(docId, null);
  } catch (error: unknown) {
    logger.error("indexer_failed", {
      doc_id: docId,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      await deps.paperless.setErrorMessage(docId, formatError("Indexierung fehlgeschlagen", error));
      await deps.paperless.addTagToDocument(docId, INDEX_ERROR_TAG);
    } catch (inner: unknown) {
      logger.error("indexer_error_tag_failed", {
        doc_id: docId,
        error: inner instanceof Error ? inner.message : String(inner),
      });
    }
  }
}
