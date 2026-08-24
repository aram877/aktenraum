import {
  findDuplicates,
  LIFECYCLE_TAGS,
  logger,
  type DocFields,
  type PaperlessClient,
  type PaperlessDocument,
} from "@aktenraum/core";

import { formatError } from "./extract.js";
import type { AsyncQueue } from "./queue.js";

const DUPLICATE_CANDIDATE_CAP = 200;
const LIFECYCLE_SET: ReadonlySet<string> = new Set(LIFECYCLE_TAGS);

/**
 * Parse the comma-separated string Paperless stores in `ai_suggested_tags`.
 * Filters out lifecycle names so an LLM suggestion can never collide with the
 * pipeline state machine, and drops fragments truncated by the 128-char
 * string-field limit (those end with the ellipsis the truncator appends).
 */
export function splitSuggestedTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const piece of raw.split(",")) {
    const name = piece.trim();
    if (!name || LIFECYCLE_SET.has(name) || name.endsWith("…")) continue;
    out.push(name);
  }
  return out;
}

export function docToFields(
  doc: PaperlessDocument,
  fieldNameById: Map<number, string>,
): DocFields {
  const values: Record<string, string> = {};
  for (const entry of (doc.custom_fields as { field: number; value: unknown }[] | undefined) ??
    []) {
    const name = fieldNameById.get(entry.field);
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

export async function findDuplicateIds(
  paperless: PaperlessClient,
  newDoc: PaperlessDocument,
  correspondentId: number,
  aiFields: Record<string, unknown>,
): Promise<number[]> {
  const dismissedId = await paperless.getTagId("ai-duplicate-dismissed");
  const newDocTags = new Set((newDoc.tags as number[] | undefined) ?? []);
  if (dismissedId !== null && newDocTags.has(dismissedId)) return [];

  let candidates = await paperless.getDocumentsWithTag(
    "ai-propagated",
    DUPLICATE_CANDIDATE_CAP,
    "-modified",
    { correspondent__id: correspondentId },
  );
  if (candidates.length === 0) return [];
  if (dismissedId !== null) {
    candidates = candidates.filter(
      (c) => !((c.tags as number[] | undefined) ?? []).includes(dismissedId),
    );
    if (candidates.length === 0) return [];
  }

  const fieldNameByIdRaw = await paperless.getCustomFieldNameById();
  const fieldNameById = new Map(
    Object.entries(fieldNameByIdRaw).map(([id, name]) => [Number(id), name]),
  );
  const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const newDocFields: DocFields = {
    id: newDoc.id,
    correspondent: asString(aiFields.ai_correspondent),
    issueDate: asString(aiFields.ai_issue_date),
    monetaryAmount: asString(aiFields.ai_monetary_amount),
    referenceNumbers: asString(aiFields.ai_reference_numbers),
    documentType: asString(aiFields.ai_document_type),
  };
  return findDuplicates(
    newDocFields,
    candidates.filter((c) => c.id !== newDoc.id).map((c) => docToFields(c, fieldNameById)),
  );
}

export async function processApprovedDocument(
  doc: PaperlessDocument,
  paperless: PaperlessClient,
  options: { indexingQueue?: AsyncQueue<number> | null } = {},
): Promise<void> {
  const docId = doc.id;
  logger.info("propagation_started", { doc_id: docId });

  const currentTags = (doc.tags as number[] | undefined) ?? [];
  const approvedId = await paperless.getTagId("ai-approved");

  try {
    const aiFields = await paperless.getAiCustomFieldValues(docId);
    const text = (key: string): string =>
      typeof aiFields[key] === "string" ? (aiFields[key] as string).trim() : "";

    const correspondentName = text("ai_correspondent");
    const correspondentId =
      correspondentName !== ""
        ? await paperless.getOrCreateCorrespondent(correspondentName)
        : null;

    const documentTypeName = text("ai_document_type");
    const documentTypeId =
      documentTypeName !== ""
        ? await paperless.getOrCreateDocumentType(documentTypeName)
        : null;

    const createdDate = text("ai_issue_date") || null;
    const aiTitle = text("ai_title") || null;

    const suggestedTagIds: number[] = [];
    for (const name of splitSuggestedTags(
      typeof aiFields.ai_suggested_tags === "string" ? aiFields.ai_suggested_tags : null,
    )) {
      suggestedTagIds.push(await paperless.getOrCreateTag(name));
    }

    const propagatedId = await paperless.getOrCreateTag("ai-propagated");

    let duplicateIds: number[] = [];
    if (correspondentId !== null) {
      try {
        duplicateIds = await findDuplicateIds(paperless, doc, correspondentId, aiFields);
      } catch (error: unknown) {
        logger.warn("duplicate_detection_failed", {
          doc_id: docId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const newTagSet = new Set(currentTags);
    if (approvedId !== null) newTagSet.delete(approvedId);
    newTagSet.add(propagatedId);
    for (const id of suggestedTagIds) newTagSet.add(id);
    if (duplicateIds.length > 0) {
      newTagSet.add(await paperless.getOrCreateTag("ai-duplicate"));
    }

    await paperless.patchDocumentNativeFields(docId, {
      correspondent: correspondentId,
      documentType: documentTypeId,
      createdDate,
      tags: [...newTagSet].sort((a, b) => a - b),
      title: aiTitle,
    });

    for (const matchedId of duplicateIds) {
      try {
        await paperless.addTagToDocument(matchedId, "ai-duplicate");
        logger.info("duplicate_detected", { new_doc_id: docId, matched_id: matchedId });
      } catch (error: unknown) {
        logger.warn("duplicate_tag_failed", {
          matched_id: matchedId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await paperless.setErrorMessage(docId, null);

    logger.info("propagation_successful", {
      doc_id: docId,
      correspondent_id: correspondentId,
      document_type_id: documentTypeId,
      created_date: createdDate,
      tags_added: suggestedTagIds.length,
    });

    options.indexingQueue?.push(docId);
  } catch (error: unknown) {
    logger.error("propagation_failed", {
      doc_id: docId,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      await paperless.setErrorMessage(
        docId,
        formatError("Übertragung fehlgeschlagen", error),
      );
      const errorId = await paperless.getOrCreateTag("ai-propagation-error");
      const recoverySet = new Set(currentTags);
      if (approvedId !== null) recoverySet.delete(approvedId);
      recoverySet.add(errorId);
      await paperless.patchDocumentNativeFields(docId, {
        tags: [...recoverySet].sort((a, b) => a - b),
      });
    } catch (inner: unknown) {
      logger.error("propagation_error_tag_failed", {
        doc_id: docId,
        error: inner instanceof Error ? inner.message : String(inner),
      });
    }
  }
}
