export type IngestSource = "email" | "upload" | "folder";
export type IngestOutcome = "new" | "duplicate" | "failed" | "running";

export interface IngestDocRef {
  id: number;
  title: string | null;
  lifecycle_tags: string[];
  missing: boolean;
}

export interface IngestItem {
  task_id: string;
  file_name: string | null;
  created: string | null;
  done: string | null;
  source: IngestSource;
  outcome: IngestOutcome;
  document: IngestDocRef | null;
  duplicate_of: IngestDocRef | null;
  message: string | null;
}

export interface IngestMail {
  id: number;
  subject: string | null;
  received: string | null;
  processed: string | null;
  status: string;
  error_summary: string | null;
}

export interface IngestSummary {
  new: number;
  duplicate: number;
  failed: number;
  running: number;
  by_source: Record<IngestSource, number>;
}

export interface IngestActivity {
  days: number;
  items: IngestItem[];
  mails: IngestMail[];
  summary: IngestSummary;
  truncated: boolean;
}

export const SOURCE_LABEL: Record<IngestSource, string> = {
  email: "E-Mail",
  upload: "Upload",
  folder: "Ordner",
};

export const OUTCOME_LABEL: Record<IngestOutcome, string> = {
  new: "Neu",
  duplicate: "Duplikat",
  failed: "Fehler",
  running: "Läuft",
};

export const MAIL_STATUS_LABEL: Record<string, string> = {
  SUCCESS: "Verarbeitet",
  FAILED: "Mit Fehlern",
  PROCESSED_WO_CONSUMPTION: "Ohne Anhang",
};

const FINAL_TAGS: ReadonlySet<string> = new Set([
  "ai-pending",
  "ai-propagated",
  "ai-rejected",
  "ai-error",
  "ai-propagation-error",
]);

/**
 * True once nothing on the page can still change on its own: no consume task
 * is running and every new document has reached a final pipeline state.
 * The activity page polls until this holds.
 */
export function activitySettled(activity: IngestActivity | null | undefined): boolean {
  if (!activity) return true;
  return activity.items.every((item) => {
    if (item.outcome === "running") return false;
    if (item.outcome !== "new" || item.document === null || item.document.missing) return true;
    return item.document.lifecycle_tags.some((tag) => FINAL_TAGS.has(tag));
  });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}
