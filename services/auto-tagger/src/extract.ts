import {
  logger,
  type DocumentExtraction,
  type LLMBackend,
  type PaperlessClient,
  type PaperlessDocument,
} from "@aktenraum/core";
import { DocumentExtractionSchema, LIFECYCLE_TAGS } from "@aktenraum/core";

import type { Settings } from "./config.js";
import { routeLifecycleTags, UNTRUSTED_SOURCE_TAGS, type RuleSet } from "./routing.js";
import {
  extractReferenceNumbersFromText,
  synthesizeSuggestedTags,
  synthesizeSummaryDe,
} from "./synthesizers.js";
import {
  buildFewShotBlock,
  buildHistoryHint,
  fallbackConfidenceReason,
  synthesizeAiTitle,
  SYSTEM_PROMPT,
  truncateText,
} from "./prompt.js";

export function formatError(label: string, error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return `${label} – ${name}: ${message}`;
}

/**
 * Names of the lifecycle tags already on this document.
 *
 * The webhook and the 30s poller can enqueue the same document, so the worker
 * re-checks on dequeue: without this, a doc extracted via the webhook gets
 * extracted a second time when the poller's batch lands, double-charging the
 * LLM and racing two tag PATCHes against each other.
 */
export async function lifecycleTagsOn(
  paperless: PaperlessClient,
  doc: PaperlessDocument,
): Promise<string[]> {
  const docTagIds = new Set((doc.tags as number[] | undefined) ?? []);
  if (docTagIds.size === 0) return [];
  const present: string[] = [];
  for (const name of LIFECYCLE_TAGS) {
    const tagId = await paperless.getTagId(name);
    if (tagId !== null && docTagIds.has(tagId)) present.push(name);
  }
  return present;
}

export async function isUntrustedSource(
  paperless: PaperlessClient,
  doc: PaperlessDocument,
): Promise<boolean> {
  const docTagIds = new Set((doc.tags as number[] | undefined) ?? []);
  if (docTagIds.size === 0) return false;
  for (const name of UNTRUSTED_SOURCE_TAGS) {
    const tagId = await paperless.getTagId(name);
    if (tagId !== null && docTagIds.has(tagId)) return true;
  }
  return false;
}

export async function applyTags(
  paperless: PaperlessClient,
  doc: PaperlessDocument,
  tagNames: readonly string[],
): Promise<void> {
  const targetIds: number[] = [];
  for (const name of tagNames) targetIds.push(await paperless.getOrCreateTag(name));
  const merged = new Set([...((doc.tags as number[] | undefined) ?? []), ...targetIds]);
  await paperless.patchDocumentNativeFields(doc.id, { tags: [...merged].sort((a, b) => a - b) });
}

/**
 * Apply every post-extraction fallback. Small local models (<=8B) routinely
 * drop optional schema fields, and the zod defaults accept the empty value
 * silently — so without these the field lands blank in Paperless. In every
 * case the LLM's own value wins when it is non-empty.
 *
 * `fullContent` (not the truncated prompt text) feeds the reference-number
 * sweep so a number on the last page of a long document still surfaces.
 */
export function applyFallbacks(
  extraction: DocumentExtraction,
  fullContent: string,
): { extraction: DocumentExtraction; applied: string[] } {
  const applied: string[] = [];
  let out = extraction;

  if (!(out.ai_title ?? "").trim()) {
    out = { ...out, ai_title: synthesizeAiTitle(out) };
    applied.push("ai_title");
  }
  if (!(out.confidence_reason ?? "").trim()) {
    out = { ...out, confidence_reason: fallbackConfidenceReason(out.confidence) };
    applied.push("confidence_reason");
  }
  if ((out.reference_numbers ?? []).length === 0) {
    const harvested = extractReferenceNumbersFromText(fullContent);
    if (harvested.length > 0) {
      out = { ...out, reference_numbers: harvested };
      applied.push("reference_numbers");
    }
  }
  if ((out.suggested_tags ?? []).length === 0) {
    out = { ...out, suggested_tags: synthesizeSuggestedTags(out) };
    applied.push("suggested_tags");
  }
  if (!(out.summary_de ?? "").trim()) {
    out = { ...out, summary_de: synthesizeSummaryDe(out) };
    applied.push("summary_de");
  }
  return { extraction: out, applied };
}

export interface ExtractDeps {
  paperless: PaperlessClient;
  backend: LLMBackend;
  settings: Settings;
  getRules: () => Promise<RuleSet>;
}

export async function processDocument(
  doc: PaperlessDocument,
  deps: ExtractDeps,
): Promise<void> {
  const { paperless, backend, settings } = deps;
  const docId = doc.id;
  const title = typeof doc.title === "string" ? doc.title : `doc-${docId}`;

  const content = await paperless.getDocumentContent(docId);
  if (!content.trim()) {
    logger.warn("document_has_no_ocr_content", { doc_id: docId, title });
    await paperless.addTagToDocument(docId, "ai-error");
    return;
  }

  const text = truncateText(content, settings.MAX_TOKENS_INPUT);
  let systemPrompt = SYSTEM_PROMPT;

  if (settings.USE_CORRESPONDENT_HISTORY) {
    const hint = await buildHistoryHint(paperless, content);
    if (hint) {
      systemPrompt = `${systemPrompt}\n\n${hint}`;
      logger.info("history_hint_attached", { doc_id: docId, chars: hint.length });
    }
  }

  if (settings.FEW_SHOT_EXAMPLES > 0) {
    let fewShot = "";
    try {
      fewShot = await buildFewShotBlock(paperless, settings.FEW_SHOT_EXAMPLES);
    } catch (error: unknown) {
      logger.warn("few_shot_build_failed", {
        doc_id: docId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (fewShot) {
      systemPrompt = `${systemPrompt}\n\n---\n\n${fewShot}`;
      logger.info("few_shot_attached", { doc_id: docId, chars: fewShot.length });
    }
  }

  let extraction: DocumentExtraction;
  try {
    extraction = (await backend.complete(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Dokumenttext:\n\n${text}` },
      ],
      DocumentExtractionSchema,
    )) as DocumentExtraction;
  } catch (error: unknown) {
    logger.error("extraction_failed", {
      doc_id: docId,
      error: error instanceof Error ? error.message : String(error),
    });
    await paperless.setErrorMessage(
      docId,
      formatError("LLM-Extraktion fehlgeschlagen", error),
    );
    await paperless.addTagToDocument(docId, "ai-error");
    return;
  }

  logger.info("extraction_successful", {
    doc_id: docId,
    document_type: extraction.document_type,
    confidence: extraction.confidence,
  });

  const { extraction: finalExtraction, applied } = applyFallbacks(extraction, content);
  if (applied.length > 0) logger.info("fallbacks_applied", { doc_id: docId, fields: applied });

  try {
    await paperless.patchDocumentAiFields(docId, finalExtraction, backend.name, backend.model);
    const rules = await deps.getRules();
    const untrustedSource = await isUntrustedSource(paperless, doc);
    const { tags, reason } = routeLifecycleTags(finalExtraction, {
      rules,
      lowConfidenceThreshold: settings.LOW_CONFIDENCE_THRESHOLD,
      untrustedSource,
    });
    await applyTags(paperless, doc, tags);
    logger.info("routing_decision", {
      doc_id: docId,
      tags,
      confidence: finalExtraction.confidence,
      document_type: finalExtraction.document_type,
      reason,
    });
  } catch (error: unknown) {
    logger.error("paperless_write_failed", {
      doc_id: docId,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      await paperless.setErrorMessage(
        docId,
        formatError("Paperless-Schreibvorgang fehlgeschlagen", error),
      );
      await paperless.addTagToDocument(docId, "ai-error");
    } catch (tagError: unknown) {
      logger.error("paperless_tag_failed", {
        doc_id: docId,
        error: tagError instanceof Error ? tagError.message : String(tagError),
      });
    }
  }
}
