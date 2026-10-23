import { LIFECYCLE_TAGS } from "@aktenraum/core";
import { Inject, Injectable } from "@nestjs/common";

import { DB, type Database } from "../db/db.module.js";
import { uploadTasks } from "../db/schema.js";
import type { PaperlessDocument } from "../paperless/paperless.gateway.js";
import { PaperlessGatewayProvider } from "../paperless/paperless.module.js";
import { collectTagIds } from "../paperless/tag-ids.js";
import type {
  IngestActivity,
  IngestDocRef,
  IngestItem,
  IngestMail,
  IngestOutcome,
  IngestSource,
  IngestSummary,
} from "./ingest.schemas.js";

export const INGEST_ITEM_CAP = 500;
const DOC_LOOKUP_CHUNK = 100;
const ERROR_SUMMARY_MAX = 200;

const STATUS_TAGS: ReadonlySet<string> = new Set([
  ...LIFECYCLE_TAGS,
  "ai-low-confidence",
  "ai-auto-approved",
  "ai-index-error",
]);

const DUPLICATE_RE = /It is a duplicate of (.*) \(#(\d+)\)\.?\s*$/s;

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s === "" ? null : s;
}

function toId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

export function classifyOutcome(task: Record<string, unknown>): IngestOutcome {
  const status = String(task.status ?? "").toUpperCase();
  if (status === "SUCCESS") return "new";
  if (status === "FAILURE" || status === "REVOKED") {
    return DUPLICATE_RE.test(String(task.result ?? "")) ? "duplicate" : "failed";
  }
  return "running";
}

/**
 * Upload ids are recorded by aktenraum itself. Paperless gives consume-folder
 * tasks no owner and mail-rule tasks the rule's owner — API uploads carry an
 * owner too, which is why the upload table is checked first.
 */
export function classifySource(
  task: Record<string, unknown>,
  uploadTaskIds: ReadonlySet<string>,
): IngestSource {
  if (uploadTaskIds.has(String(task.task_id ?? ""))) return "upload";
  if (task.owner === null || task.owner === undefined) return "folder";
  return "email";
}

/** `{id, title}` of the original a duplicate import was rejected against. */
export function parseDuplicateTarget(
  task: Record<string, unknown>,
): { id: number; title: string | null } | null {
  const match = DUPLICATE_RE.exec(String(task.result ?? ""));
  const fromRelated = toId(task.related_document);
  const fromMessage = match?.[2] !== undefined ? Number(match[2]) : null;
  const id = fromRelated ?? fromMessage;
  if (id === null) return null;
  return { id, title: match?.[1]?.trim() || null };
}

/** Paperless prefixes every message with "<file>: "; drop it once. */
export function failureMessage(task: Record<string, unknown>): string | null {
  const result = str(task.result);
  if (result === null) return null;
  const file = str(task.task_file_name);
  return file !== null && result.startsWith(`${file}: `) ? result.slice(file.length + 2) : result;
}

/** A Celery traceback is useless in the UI; its last line says what happened. */
export function summariseMailError(error: unknown): string | null {
  const text = str(error);
  if (text === null || text === "None") return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  const last = lines[lines.length - 1] ?? null;
  if (last === null) return null;
  return last.length > ERROR_SUMMARY_MAX ? `${last.slice(0, ERROR_SUMMARY_MAX - 1)}…` : last;
}

function withinWindow(value: unknown, sinceMs: number): boolean {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) && ms >= sinceMs;
}

function emptySummary(): IngestSummary {
  return {
    new: 0,
    duplicate: 0,
    failed: 0,
    running: 0,
    by_source: { email: 0, upload: 0, folder: 0 },
  };
}

@Injectable()
export class IngestService {
  constructor(
    private readonly gatewayProvider: PaperlessGatewayProvider,
    @Inject(DB) private readonly db: Database,
  ) {}

  async activity(days: number, now: number = Date.now()): Promise<IngestActivity> {
    const gateway = this.gatewayProvider.require();
    const sinceMs = now - days * 24 * 60 * 60 * 1000;

    const [tasks, mails, uploadIds] = await Promise.all([
      gateway.listConsumeTasks(),
      gateway.listProcessedMail(),
      this.uploadTaskIds(),
    ]);

    const inWindow = tasks
      .filter((task) => withinWindow(task.date_created, sinceMs))
      .sort((a, b) => String(b.date_created).localeCompare(String(a.date_created)));
    const kept = inWindow.slice(0, INGEST_ITEM_CAP);

    const drafts = kept.map((task) => {
      const outcome = classifyOutcome(task);
      const newId = outcome === "new" ? toId(task.related_document) : null;
      const target = outcome === "duplicate" ? parseDuplicateTarget(task) : null;
      return { task, outcome, source: classifySource(task, uploadIds), newId, target };
    });

    const refIds = new Set<number>();
    for (const d of drafts) {
      if (d.newId !== null) refIds.add(d.newId);
      if (d.target !== null) refIds.add(d.target.id);
    }
    const docs = await this.lookupDocs([...refIds]);

    const ref = (id: number, fallbackTitle: string | null): IngestDocRef => {
      const doc = docs.get(id);
      if (doc === undefined) return { id, title: fallbackTitle, lifecycle_tags: [], missing: true };
      return { ...doc, missing: false };
    };

    const summary = emptySummary();
    const items: IngestItem[] = drafts.map((d) => {
      summary[d.outcome] += 1;
      summary.by_source[d.source] += 1;
      return {
        task_id: String(d.task.task_id ?? ""),
        file_name: str(d.task.task_file_name),
        created: str(d.task.date_created),
        done: str(d.task.date_done),
        source: d.source,
        outcome: d.outcome,
        document: d.newId !== null ? ref(d.newId, null) : null,
        duplicate_of: d.target !== null ? ref(d.target.id, d.target.title) : null,
        message: d.outcome === "failed" ? failureMessage(d.task) : null,
      };
    });

    const mailItems: IngestMail[] = mails
      .filter((mail) => withinWindow(mail.processed ?? mail.received, sinceMs))
      .sort((a, b) => String(b.processed).localeCompare(String(a.processed)))
      .map((mail) => ({
        id: Number(mail.id),
        subject: str(mail.subject),
        received: str(mail.received),
        processed: str(mail.processed),
        status: String(mail.status ?? "UNKNOWN"),
        error_summary: summariseMailError(mail.error),
      }));

    return {
      days,
      items,
      mails: mailItems,
      summary,
      truncated: inWindow.length > kept.length,
    };
  }

  private async uploadTaskIds(): Promise<Set<string>> {
    const rows = await this.db.select({ taskId: uploadTasks.taskId }).from(uploadTasks);
    return new Set(rows.map((row) => row.taskId));
  }

  private async lookupDocs(
    ids: number[],
  ): Promise<Map<number, Omit<IngestDocRef, "missing">>> {
    const out = new Map<number, Omit<IngestDocRef, "missing">>();
    if (ids.length === 0) return out;
    const gateway = this.gatewayProvider.require();
    const found: PaperlessDocument[] = [];
    for (let i = 0; i < ids.length; i += DOC_LOOKUP_CHUNK) {
      const chunk = ids.slice(i, i + DOC_LOOKUP_CHUNK);
      const payload = await gateway.searchDocuments(
        { id__in: chunk.join(","), fields: "id,title,tags" },
        { pageSize: chunk.length },
      );
      found.push(...((payload.results as PaperlessDocument[] | undefined) ?? []));
    }
    const tagNames = await gateway.listTagsCovering(collectTagIds(found));
    const nameById = new Map(Object.entries(tagNames).map(([name, id]) => [id, name]));
    for (const doc of found) {
      const lifecycle = ((doc.tags as number[] | undefined) ?? [])
        .map((tid) => nameById.get(tid))
        .filter((name): name is string => name !== undefined && STATUS_TAGS.has(name));
      out.set(doc.id, { id: doc.id, title: str(doc.title), lifecycle_tags: lifecycle });
    }
    return out;
  }
}
