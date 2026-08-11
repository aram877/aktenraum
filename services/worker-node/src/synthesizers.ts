import type { DocumentExtraction } from "@aktenraum/core-ts";

const GERMAN_MONTHS: Record<number, string> = {
  1: "Januar",
  2: "Februar",
  3: "März",
  4: "April",
  5: "Mai",
  6: "Juni",
  7: "Juli",
  8: "August",
  9: "September",
  10: "Oktober",
  11: "November",
  12: "Dezember",
};

export const REFERENCE_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["aktenzeichen", /Aktenzeichen[:\s]+([A-Z0-9][A-Z0-9\-./_]{2,31})/gi],
  ["az", /\bAz\.?[:\s]+([A-Z0-9][A-Z0-9\-./_]{2,31})/gi],
  ["rechnungsnr", /Rechnungs(?:-?Nr\.?|nummer)[:\s]+([A-Z0-9][A-Z0-9\-./_]{2,31})/gi],
  ["vertragsnr", /Vertrags(?:-?Nr\.?|nummer)[:\s]+([A-Z0-9][A-Z0-9\-./_]{2,31})/gi],
  ["kundennr", /Kunden(?:-?Nr\.?|nummer)[:\s]+([A-Z0-9][A-Z0-9\-./_]{2,31})/gi],
  ["vorgangsnr", /Vorgangs?(?:-?Nr\.?|nummer)[:\s]+([A-Z0-9][A-Z0-9\-./_]{2,31})/gi],
  ["bestellnr", /Bestell(?:-?Nr\.?|nummer)[:\s]+([A-Z0-9][A-Z0-9\-./_]{2,31})/gi],
  ["auftragsnr", /Auftrags(?:-?Nr\.?|nummer)[:\s]+([A-Z0-9][A-Z0-9\-./_]{2,31})/gi],
  ["policennr", /Policen(?:-?Nr\.?|nummer)[:\s]+([A-Z0-9][A-Z0-9\-./_]{2,31})/gi],
  ["steuernr", /Steuer(?:-?Nr\.?|nummer)[:\s]+([0-9][0-9\-./_]{2,31})/gi],
];

export function formatIssueDateDe(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const candidate = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  const month = GERMAN_MONTHS[parsed.getUTCMonth() + 1];
  if (month === undefined) return null;
  return `${month} ${parsed.getUTCFullYear()}`;
}

/**
 * Deterministic German summary for when the LLM dropped `summary_de`.
 * Small models (<=8B) routinely emit "" despite the prompt rule, and the
 * zod/Pydantic default accepts it, so without this the field lands blank in
 * Paperless. Modest by design: the goal is "non-empty, not wrong".
 */
export function synthesizeSummaryDe(extraction: DocumentExtraction): string {
  const docType = extraction.document_type;
  const correspondent = (extraction.correspondent ?? "").trim();
  const title = (extraction.ai_title ?? "").trim();
  const dateDe = formatIssueDateDe(extraction.key_dates?.issue ?? null);

  const sentences: string[] = [];
  if (correspondent && dateDe) sentences.push(`${docType} von ${correspondent} vom ${dateDe}.`);
  else if (correspondent) sentences.push(`${docType} von ${correspondent}.`);
  else if (dateDe) sentences.push(`${docType} vom ${dateDe}.`);
  else sentences.push(`${docType}.`);

  const first = sentences[0] as string;
  if (title && !first.toLowerCase().includes(title.toLowerCase())) {
    sentences.push(`Betreff: ${title}.`);
  }

  const refs = (extraction.reference_numbers ?? [])
    .filter((r) => r && r.trim())
    .slice(0, 3);
  if (refs.length > 0) {
    sentences.push(`Aktenzeichen: ${refs.join(", ")}.`);
  } else {
    const tags = (extraction.suggested_tags ?? []).filter((t) => t && t.trim()).slice(0, 3);
    if (tags.length > 0) sentences.push(`Themen: ${tags.join(", ")}.`);
  }

  return sentences.join(" ");
}

/** Structural fallback tags when the LLM returns []. */
export function synthesizeSuggestedTags(extraction: DocumentExtraction): string[] {
  const tags: string[] = [extraction.document_type];
  const issue = (extraction.key_dates?.issue ?? "").trim();
  if (issue.length >= 4 && /^\d{4}$/.test(issue.slice(0, 4))) tags.push(issue.slice(0, 4));
  return tags;
}

/**
 * Pull common German reference numbers out of OCR text when the LLM emitted
 * none. Conservative on purpose — a greedy regex would harvest dates, phone
 * numbers and IBANs, producing noisy "Aktenzeichen" the user has to clean up.
 */
export function extractReferenceNumbersFromText(text: string, limit = 5): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [, pattern] of REFERENCE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = (match[1] ?? "").replace(/^[.,;:\-\s]+|[.,;:\-\s]+$/g, "");
      if (!value) continue;
      const lc = value.toLowerCase();
      if (seen.has(lc)) continue;
      seen.add(lc);
      out.push(value);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
