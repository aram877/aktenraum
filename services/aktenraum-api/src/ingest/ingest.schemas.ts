export type IngestSource = "email" | "upload" | "folder";
export type IngestOutcome = "new" | "duplicate" | "failed" | "running";

export interface IngestDocRef {
  id: number;
  title: string | null;
  lifecycle_tags: string[];
  /** The document no longer exists (trashed or deleted). */
  missing: boolean;
}

export interface IngestItem {
  task_id: string;
  file_name: string | null;
  created: string | null;
  done: string | null;
  source: IngestSource;
  outcome: IngestOutcome;
  /** The document this import created (outcome `new`). */
  document: IngestDocRef | null;
  /** The existing document this import duplicated (outcome `duplicate`). */
  duplicate_of: IngestDocRef | null;
  /** Paperless's message, filename prefix stripped (outcome `failed`). */
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
  /** More consume tasks matched the window than were returned. */
  truncated: boolean;
}
