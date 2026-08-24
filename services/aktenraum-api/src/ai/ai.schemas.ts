import { DocumentTypeSchema } from "@aktenraum/core";
import { z } from "zod";

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function clampDate(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const match = ISO_DATE_RE.exec(value);
  if (match === null) return value;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return value;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > lastDay) {
    return `${match[1]}-${match[2]}-${String(lastDay).padStart(2, "0")}`;
  }
  return value;
}

const clampedDate = z.preprocess(
  clampDate,
  z
    .string()
    .regex(ISO_DATE_RE, "expected YYYY-MM-DD")
    .nullable()
    .optional(),
);

export const searchFilterSchema = z
  .object({
    document_type: DocumentTypeSchema.nullable().optional(),
    correspondent: z.string().nullable().optional(),
    date_from: clampedDate,
    date_to: clampedDate,
    text: z.string().nullable().optional(),
    tags: z.array(z.string().nullable()).nullable().optional(),
  })
  .transform((raw) => {
    const correspondent = raw.correspondent?.trim() ?? null;
    const text = raw.text?.trim() ?? null;
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const entry of raw.tags ?? []) {
      if (entry === null || entry === undefined) continue;
      const stripped = entry.trim();
      if (stripped === "" || seen.has(stripped)) continue;
      tags.push(stripped);
      seen.add(stripped);
    }
    return {
      document_type: raw.document_type ?? null,
      correspondent: correspondent === "" ? null : correspondent,
      date_from: raw.date_from ?? null,
      date_to: raw.date_to ?? null,
      text: text === "" ? null : text,
      tags,
    };
  });

export type SearchFilter = z.infer<typeof searchFilterSchema>;

export const EMPTY_FILTER: SearchFilter = {
  document_type: null,
  correspondent: null,
  date_from: null,
  date_to: null,
  text: null,
  tags: [],
};

export interface DocumentSummary {
  id: number;
  title: string;
  original_file_name: string | null;
  correspondent: string | null;
  document_type: string | null;
  created: string | null;
  lifecycle_tags: string[];
  tags: string[];
  ai_error_message: string | null;
}

export const askRequestSchema = z
  .object({
    query: z.string().nullable().optional(),
    filter: searchFilterSchema.nullable().optional(),
  })
  .superRefine((payload, ctx) => {
    const hasQuery = payload.query !== null && payload.query !== undefined;
    const hasFilter = payload.filter !== null && payload.filter !== undefined;
    if (hasQuery === hasFilter) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactly one of `query` or `filter` is required",
      });
      return;
    }
    if (hasQuery && (payload.query as string).trim() === "") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "`query` must not be empty" });
    }
  });

export type AskRequest = z.infer<typeof askRequestSchema>;

export interface AskResponse {
  filter: SearchFilter;
  results: DocumentSummary[];
  explanation: string;
  total: number;
}

export const answerRequestSchema = z.object({
  question: z.string().min(1),
});
export type AnswerRequest = z.infer<typeof answerRequestSchema>;

export const answerOutputSchema = z.object({
  answer_de: z.string(),
  cited_ids: z.array(z.number()).default([]),
});
export type AnswerOutput = z.infer<typeof answerOutputSchema>;

export interface TypeSpecificField {
  name: string;
  label: string;
  value: string;
}

export interface AnswerCandidate {
  id: number;
  title: string;
  correspondent: string | null;
  document_type: string | null;
  created: string | null;
  ai_summary_de: string | null;
  ai_issue_date: string | null;
  ai_reference_numbers: string | null;
  type_specific_fields: TypeSpecificField[];
}

export interface AnswerResponse {
  question: string;
  answer_de: string;
  citations: DocumentSummary[];
  filter: SearchFilter;
  total: number;
}
