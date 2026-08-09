import { z } from "zod";
import { DocumentTypeSchema } from "./extraction.js";

/**
 * Per-document-type auto-approve rule. `enabled` + `minConfidence` together
 * decide whether the worker routes an extraction to `ai-approved`
 * (auto-approve) or `ai-pending` (review). The rule set is edited from the
 * SPA's Settings page, persisted by the API, and consumed by the worker over
 * HTTP with a 60-second TTL cache.
 */
export const AutoApproveRuleSchema = z.object({
  document_type: DocumentTypeSchema,
  enabled: z.boolean().default(false),
  min_confidence: z.number().min(0).max(1).default(0.9),
  updated_at: z.string().datetime().nullable().default(null),
  updated_by: z.string().nullable().default(null),
});
export type AutoApproveRule = z.infer<typeof AutoApproveRuleSchema>;
