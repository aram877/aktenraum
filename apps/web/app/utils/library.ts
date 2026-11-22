import { classify } from "./badge";
import { FAMILIES, familyByKey, familyOfType, type DocFamily } from "./doc-types";
import { userFacingTags } from "./lifecycle-tags";

export const DOC_TYPES = [
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

export const ORDERING_OPTIONS = [
  { value: "-created", label: "Dokumentdatum (neueste zuerst)" },
  { value: "created", label: "Dokumentdatum (älteste zuerst)" },
  { value: "-modified", label: "Zuletzt geändert (neueste zuerst)" },
  { value: "modified", label: "Zuletzt geändert (älteste zuerst)" },
  { value: "title", label: "Titel (A–Z)" },
  { value: "-title", label: "Titel (Z–A)" },
] as const;

export const DEFAULT_ORDERING = "-created";

// Processing-state filter. "review" is not a server status: pending docs live
// in the review tab, so picking it switches tabs instead of filtering.
export const REVIEW_STATUS = "review";
export const STATUS_OPTIONS = [
  { value: "", label: "Alle" },
  { value: "error", label: "Fehler" },
  { value: "unprocessed", label: "Wartet auf KI" },
  { value: REVIEW_STATUS, label: "In Prüfung" },
  { value: "approved", label: "Wird übertragen" },
  { value: "done", label: "Fertig" },
  { value: "rejected", label: "Abgelehnt" },
] as const;

const SERVER_STATUSES: ReadonlySet<string> = new Set(["error", "unprocessed", "approved", "done", "rejected"]);

export function libraryStatusParam(value: string): string {
  return SERVER_STATUSES.has(value) ? value : "";
}

export function toQueryString(query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === "" || item === null || item === undefined) continue;
        params.append(key, String(item));
      }
      continue;
    }
    params.append(key, String(value));
  }
  return params.toString();
}

export function sortTagsImportantFirst(tags: readonly string[]): string[] {
  return [...tags].sort((a, b) => {
    if (a === "wichtig") return -1;
    if (b === "wichtig") return 1;
    return a.localeCompare(b, "de");
  });
}

export function totalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function firstParam(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return typeof value === "string" ? value : "";
}

export function allParams(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return typeof value === "string" ? [value] : [];
}

export function cleanLibraryQuery(merged: Record<string, unknown>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      out[key] = value.map(String);
      continue;
    }
    if (key === "page" && Number(value) === 1) continue;
    if (key === "ordering" && value === DEFAULT_ORDERING) continue;
    out[key] = String(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ui-redesign-foundation helpers (pure, unit-tested in tests/unit/library.spec.ts)

/** Native document types the API should filter by: an explicit type wins over its area. */
export function libraryTypeFilter(family: string, documentType: string): string[] | null {
  if (documentType) return [documentType];
  const area = familyByKey(family);
  return area ? [...area.types] : null;
}

export interface FamilyCount {
  family: DocFamily;
  count: number;
  types: { name: string; count: number }[];
}

/** Area counts from the type facet; unknown type names count as Sonstiges. Areas without documents are kept. */
export function familyCounts(facet: readonly { name: string; count: number }[]): FamilyCount[] {
  const byKey = new Map<string, FamilyCount>(FAMILIES.map((f) => [f.key, { family: f, count: 0, types: [] }]));
  for (const entry of facet) {
    if (entry.count <= 0) continue;
    const bucket = byKey.get(familyOfType(entry.name).key)!;
    bucket.count += entry.count;
    bucket.types.push({ name: entry.name, count: entry.count });
  }
  return [...byKey.values()];
}

const MONTH = new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric", timeZone: "UTC" });

/** "2026-11-18" or an ISO timestamp → "18.11.2026"; null/garbage → "—". */
export function formatDocDate(value: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  return match ? `${match[3]}.${match[2]}.${match[1]}` : "—";
}

export interface RowGroup<T> {
  key: string;
  /** "November 2026", "Ohne Datum", or null when the list is not grouped. */
  label: string | null;
  rows: T[];
}

/** Month groups when sorted by document date; one unlabelled group otherwise. Keeps the server order. */
export function groupByMonth<T extends { created: string | null }>(rows: readonly T[], ordering: string): RowGroup<T>[] {
  if (ordering !== "-created" && ordering !== "created") return [{ key: "all", label: null, rows: [...rows] }];
  const groups: RowGroup<T>[] = [];
  for (const row of rows) {
    const match = /^(\d{4})-(\d{2})/.exec(row.created ?? "");
    const key = match ? `${match[1]}-${match[2]}` : "none";
    let group = groups.at(-1);
    if (group?.key !== key) {
      const label = match ? MONTH.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1))) : "Ohne Datum";
      group = { key, label, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}

export interface RowStatus {
  label: string;
  title: string;
  tone: "danger" | "warning" | "info";
}

/** The row's status label, only when it needs attention; finished / auto-approved / rejected rows show nothing. */
export function rowStatus(tags: readonly string[], errorMessage: string | null, inFlight: boolean): RowStatus | null {
  if (inFlight) return { label: "KI läuft", title: "Wird gerade vom Auto-Tagger bearbeitet.", tone: "info" };
  const state = classify(tags, errorMessage);
  if (state.variant === "danger") return { label: state.label, title: state.title, tone: "danger" };
  if (state.variant === "warning") {
    return { label: state.label === "Bereit zum Prüfen" ? "Prüfen" : state.label, title: state.title, tone: "warning" };
  }
  if (state.variant === "info") return { label: "Wird übertragen", title: state.title, tone: "info" };
  if (state.label === "Wartet auf KI") return { label: state.label, title: state.title, tone: "info" };
  return null;
}

/** ★ plus the remaining user-facing tags (for the "+N" chip and its tooltip). */
export function tagSummary(tags: readonly string[]): { star: boolean; others: string[] } {
  const visible = sortTagsImportantFirst(userFacingTags(tags));
  return { star: visible.includes("wichtig"), others: visible.filter((t) => t !== "wichtig") };
}
