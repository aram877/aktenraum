import { z } from "zod";

export interface InboxItem {
  id: number;
  title: string;
  original_file_name: string | null;
  created: string | null;
  added: string | null;
  ai_correspondent: string | null;
  ai_document_type: string | null;
  ai_title: string | null;
  ai_issue_date: string | null;
  ai_confidence: number | null;
  low_confidence: boolean;
  ai_error_message: string | null;
}

export interface InboxDetail extends InboxItem {
  ai_reference_numbers: string | null;
  ai_suggested_tags: string | null;
  ai_summary_de: string | null;
  ai_backend: string | null;
  ai_model: string | null;
  ai_confidence_reason: string | null;
  content_excerpt: string;
  tags: string[];
  type_fields: Record<string, string> | null;
}

export interface InboxList {
  results: InboxItem[];
  total: number;
  page: number;
  page_size: number;
}

const nullableString = z.string().nullable().optional();

export const inboxFieldUpdateSchema = z.object({
  ai_document_type: nullableString,
  ai_correspondent: nullableString,
  ai_title: nullableString,
  ai_issue_date: nullableString,
  ai_reference_numbers: nullableString,
  ai_suggested_tags: nullableString,
  ai_summary_de: nullableString,
});

export type InboxFieldUpdate = z.infer<typeof inboxFieldUpdateSchema>;

export function populatedFields(update: InboxFieldUpdate | null | undefined): Record<string, unknown> {
  if (update === null || update === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(update)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
