import type { SearchFilter } from "./ai.schemas.js";

export function explainFilter(filter: SearchFilter): string {
  const parts: string[] = [];
  if (filter.document_type !== null && filter.document_type !== undefined) {
    parts.push(`Dokumenttyp '${filter.document_type}'`);
  }
  if (filter.correspondent) {
    parts.push(`Korrespondent '${filter.correspondent}'`);
  }
  if (
    filter.date_from !== null &&
    filter.date_from !== undefined &&
    filter.date_to !== null &&
    filter.date_to !== undefined
  ) {
    parts.push(`Zeitraum ${filter.date_from} bis ${filter.date_to}`);
  } else if (filter.date_from !== null && filter.date_from !== undefined) {
    parts.push(`ab ${filter.date_from}`);
  } else if (filter.date_to !== null && filter.date_to !== undefined) {
    parts.push(`bis ${filter.date_to}`);
  }
  if (filter.text) {
    parts.push(`Stichwort '${filter.text}'`);
  }
  if (filter.tags && filter.tags.length > 0) {
    const joined = filter.tags.map((t) => `'${t}'`).join(", ");
    parts.push(`Tags ${joined}`);
  }

  if (parts.length === 0) {
    return "Ich habe verstanden: keine Einschränkungen.";
  }
  return "Ich habe verstanden: " + parts.join(", ") + ".";
}
