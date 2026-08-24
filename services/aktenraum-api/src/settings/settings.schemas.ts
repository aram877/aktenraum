import { DOCUMENT_TYPES, DocumentTypeSchema } from "@aktenraum/core";
import { z } from "zod";

export const DEFAULT_MODEL = "qwen2.5:14b-instruct-q8_0";

const MAX_MODEL_LENGTH = 128;

export interface LLMSettings {
  model: string;
}

export interface ActiveModelResponse {
  ollama_model: string;
}

export interface AvailableModelsResponse {
  models: string[];
}

export const llmSettingsUpdateSchema = z.object({
  model: z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, "model must not be empty")
    .refine(
      (value) => value.length <= MAX_MODEL_LENGTH,
      `model must be at most ${MAX_MODEL_LENGTH} characters`,
    ),
});
export type LLMSettingsUpdate = z.infer<typeof llmSettingsUpdateSchema>;

export interface AutoApproveRule {
  document_type: string;
  enabled: boolean;
  min_confidence: number;
  updated_at: string | null;
  updated_by: string | null;
}

export interface AutoApproveRulesResponse {
  rules: AutoApproveRule[];
}

const autoApproveEntrySchema = z.object({
  document_type: DocumentTypeSchema,
  enabled: z.boolean(),
  min_confidence: z.number().min(0).max(1),
});

export const autoApproveRulesUpdateSchema = z
  .object({ rules: z.array(autoApproveEntrySchema) })
  .superRefine((payload, ctx) => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const entry of payload.rules) {
      if (seen.has(entry.document_type)) duplicates.add(entry.document_type);
      seen.add(entry.document_type);
    }
    if (duplicates.size > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate document_type entries: ${[...duplicates].sort().join(", ")}`,
      });
    }
    const missing = DOCUMENT_TYPES.filter((type) => !seen.has(type));
    if (missing.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Missing document_type entries: ${[...missing].sort().join(", ")}`,
      });
    }
  });

export type AutoApproveRulesUpdate = z.infer<typeof autoApproveRulesUpdateSchema>;
