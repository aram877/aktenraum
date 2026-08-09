import { z } from "zod";

// Mirrors aktenraum_core.models.extraction.DocumentType (Python StrEnum).
// Values (not keys) are what the LLM emits and what Paperless stores, so the
// German values below are the source of truth, same as the Python side.
export const DOCUMENT_TYPES = [
  "Rechnung",
  "Gehaltsabrechnung",
  "Kontoauszug",
  "Nebenkostenabrechnung",
  "Hausgeldabrechnung",
  "Mahnung",
  "Vertrag",
  "Kündigung",
  "Versicherung",
  "Steuer",
  "Lohnsteuerbescheinigung",
  "Spendenbescheinigung",
  "Bescheid",
  "Behördenbrief",
  "Sozialversicherungsmeldung",
  "Kfz",
  "Bußgeldbescheid",
  "Arztbrief",
  "Krankschreibung",
  "Garantie",
  "Urkunde",
  "Ausweis",
  "Zeugnis",
  "Arbeitszeugnis",
  "Mitgliedschaft",
  "Beleg",
  "Sonstiges",
] as const;

export const DocumentTypeSchema = z.enum(DOCUMENT_TYPES);
export type DocumentType = z.infer<typeof DocumentTypeSchema>;

// Mirrors aktenraum_core.models.extraction.CoercedStr — small LLMs sometimes
// emit a non-string (e.g. an integer) where the schema asks for a string.
export const CoercedStrSchema = z.preprocess(
  (v) => (typeof v === "string" ? v : String(v)),
  z.string(),
);

// Mirrors aktenraum_core.models.extraction.CoercedList — small LLMs often
// emit `null` for an empty array field instead of `[]`. Coerce None → []
// rather than rejecting the extraction over a representation choice with no
// semantic meaning.
export const CoercedListSchema = z.preprocess(
  (v) => (v === null || v === undefined ? [] : v),
  z.array(CoercedStrSchema),
);

// Mirrors aktenraum_core.models.extraction.KeyDates.
export const KeyDatesSchema = z.object({
  issue: z.string().nullable().default(null),
});
export type KeyDates = z.infer<typeof KeyDatesSchema>;

// Mirrors aktenraum_core.models.extraction.DocumentExtraction.
export const DocumentExtractionSchema = z.object({
  document_type: DocumentTypeSchema,
  correspondent: z.string().nullable().default(null),
  ai_title: z.string().nullable().default(null),
  key_dates: KeyDatesSchema.default({ issue: null }),
  reference_numbers: CoercedListSchema.default([]),
  suggested_tags: CoercedListSchema.default([]),
  summary_de: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0.5),
  confidence_reason: z.string().nullable().default(null),
});
export type DocumentExtraction = z.infer<typeof DocumentExtractionSchema>;
