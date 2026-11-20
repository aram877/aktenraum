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

export interface InboxList {
  results: InboxItem[];
  total: number;
  page: number;
  page_size: number;
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
  /** The document's home space ("Akte"); null = not assigned yet. Optional for older api builds. */
  home_space?: HomeSpaceSummary | null;
  /** Set when the document reaches the caller through a share. */
  shared_by?: SharedBy | null;
  /** How the caller reaches the document; the page hides actions it would be refused. */
  access?: DocumentAccess | null;
}

export interface SharedBy {
  username: string;
  role: "viewer" | "editor";
  expires_at: string | null;
}

export type DocumentAccess =
  | { via: "space"; role: "owner" | "editor" | "viewer" }
  | { via: "share"; role: "viewer" | "editor" }
  | { via: "admin"; role: "admin" };

/** Whether the caller may change the document's state (approve, reprocess, star, move, delete). */
export function canChangeState(access: DocumentAccess | null | undefined): boolean {
  if (access == null) return true; // older api builds: the server still decides
  if (access.via === "share") return false;
  return access.via === "admin" || access.role !== "viewer";
}

/** Whether the caller may correct AI and type fields. */
export function canEditFields(access: DocumentAccess | null | undefined): boolean {
  if (access == null) return true;
  return access.role !== "viewer";
}

/** "Geteilt von alice · bis 31.12.2026" */
export function sharedByLabel(shared: SharedBy): string {
  const until = shared.expires_at ? ` · bis ${formatShareDate(shared.expires_at)}` : "";
  return `Geteilt von ${shared.username}${until}`;
}

export function formatShareDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString("de-DE");
}

export interface HomeSpaceSummary {
  id: number;
  name: string;
  kind: "personal" | "shared";
  /** aktenraum username of the owning member. */
  owner: string | null;
}

export const FORM_FIELDS = [
  "ai_document_type",
  "ai_correspondent",
  "ai_title",
  "ai_issue_date",
  "ai_reference_numbers",
  "ai_suggested_tags",
  "ai_summary_de",
] as const;

export type FormField = (typeof FORM_FIELDS)[number];
export type FormState = Record<FormField, string>;
export type InboxFieldUpdate = Partial<Record<FormField, string | null>>;

export const EMPTY_FORM: FormState = {
  ai_document_type: "",
  ai_correspondent: "",
  ai_title: "",
  ai_issue_date: "",
  ai_reference_numbers: "",
  ai_suggested_tags: "",
  ai_summary_de: "",
};

export function detailToForm(detail: InboxDetail): FormState {
  const out = { ...EMPTY_FORM };
  for (const field of FORM_FIELDS) out[field] = detail[field] ?? "";
  return out;
}

export function mergeHydration(
  current: FormState,
  lastHydrated: FormState | null,
  next: FormState,
): FormState {
  if (lastHydrated === null) return next;
  const merged = { ...current };
  let changed = false;
  for (const field of FORM_FIELDS) {
    if (current[field] === lastHydrated[field] && current[field] !== next[field]) {
      merged[field] = next[field];
      changed = true;
    }
  }
  return changed ? merged : current;
}

export function buildDirtyPatch(form: FormState, detail: InboxDetail): InboxFieldUpdate {
  const out: InboxFieldUpdate = {};
  for (const field of FORM_FIELDS) {
    const value = form[field].trim();
    const original = (detail[field] ?? "").trim();
    if (value !== original) out[field] = value === "" ? null : value;
  }
  return out;
}

export function pickNeighbour(
  ids: readonly number[],
  currentId: number,
  direction: "next" | "prev",
): number | undefined {
  const remaining = ids.filter((d) => d !== currentId);
  if (remaining.length === 0) return undefined;
  const currentPos = ids.indexOf(currentId);
  if (currentPos === -1) {
    return direction === "next" ? remaining[0] : remaining[remaining.length - 1];
  }
  if (direction === "next") {
    return remaining.find((d) => ids.indexOf(d) > currentPos) ?? remaining[0];
  }
  const before = remaining.filter((d) => ids.indexOf(d) < currentPos);
  return before.length > 0 ? before[before.length - 1] : remaining[remaining.length - 1];
}

export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function pump(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await worker(item);
    }
  }
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, pump);
  await Promise.all(lanes);
  return results;
}

export function nextPageParam(lastPage: InboxList, allPages: InboxList[]): number | undefined {
  const loaded = allPages.reduce((n, p) => n + p.results.length, 0);
  if (loaded >= lastPage.total) return undefined;
  return lastPage.page + 1;
}

export function pruneSelection(
  selected: ReadonlySet<number>,
  visibleIds: readonly number[],
): Set<number> {
  if (visibleIds.length === 0) return new Set(selected);
  const visible = new Set(visibleIds);
  const next = new Set<number>();
  for (const id of selected) if (visible.has(id)) next.add(id);
  return next;
}

export function formatConfidence(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${Math.round(value * 100)} %`;
}
