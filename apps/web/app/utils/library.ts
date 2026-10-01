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
