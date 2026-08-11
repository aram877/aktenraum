import type { DocumentExtraction, DocumentType } from "@aktenraum/core-ts";

export interface AutoApproveRule {
  documentType: DocumentType;
  enabled: boolean;
  minConfidence: number;
}

export interface RuleSet {
  byType: Map<DocumentType, AutoApproveRule>;
  failClosed: boolean;
}

/**
 * Closed enum — runbooks grep these values out of the `routing_decision`
 * log line, so do not rename them.
 */
export type RoutingReason =
  | "auto_approved"
  | "type_disabled"
  | "confidence_below_min"
  | "rules_unreachable_fail_closed"
  | "untrusted_source_no_auto_approve";

export const UNTRUSTED_SOURCE_TAGS: readonly string[] = ["email-ingested"];

function pending(extraction: DocumentExtraction, lowConfidenceThreshold: number): string[] {
  const tags = ["ai-pending"];
  if (extraction.confidence < lowConfidenceThreshold) tags.push("ai-low-confidence");
  return tags;
}

/**
 * Decide the lifecycle/auxiliary tags for a fresh extraction.
 *
 * Auto-approve requires BOTH `rule.enabled` AND `confidence >= min_confidence`.
 * `untrustedSource` forces the pending path unconditionally: when an external
 * sender controls the OCR text (IMAP ingestion), a prompt-injection payload
 * could otherwise drive a fake high confidence straight past the gate.
 */
export function routeLifecycleTags(
  extraction: DocumentExtraction,
  options: {
    rules: RuleSet;
    lowConfidenceThreshold: number;
    untrustedSource?: boolean;
  },
): { tags: string[]; reason: RoutingReason } {
  const { rules, lowConfidenceThreshold } = options;
  if (rules.failClosed) {
    return {
      tags: pending(extraction, lowConfidenceThreshold),
      reason: "rules_unreachable_fail_closed",
    };
  }
  if (options.untrustedSource === true) {
    return {
      tags: pending(extraction, lowConfidenceThreshold),
      reason: "untrusted_source_no_auto_approve",
    };
  }
  const rule = rules.byType.get(extraction.document_type);
  if (rule === undefined || !rule.enabled) {
    return { tags: pending(extraction, lowConfidenceThreshold), reason: "type_disabled" };
  }
  if (extraction.confidence < rule.minConfidence) {
    return {
      tags: pending(extraction, lowConfidenceThreshold),
      reason: "confidence_below_min",
    };
  }
  return { tags: ["ai-approved", "ai-auto-approved"], reason: "auto_approved" };
}
