import { readFile, unlink } from "node:fs/promises";

import { logger } from "@aktenraum/core";
import { Inject, Injectable } from "@nestjs/common";
import { lt } from "drizzle-orm";

import { SETTINGS, type Settings } from "../config/settings.js";
import { DB, type Database } from "../db/db.module.js";
import { uploadTasks } from "../db/schema.js";
import { PaperlessAuthError } from "../paperless/errors.js";
import { PaperlessGatewayProvider } from "../paperless/paperless.module.js";

export const UPLOAD_ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/tiff",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.text",
  "text/plain",
]);

export interface UploadResult {
  filename: string;
  status: "accepted" | "error";
  task_id?: string | null;
  detail?: string | null;
}

export interface UploadResponse {
  results: UploadResult[];
}

export interface IncomingFile {
  originalname: string;
  mimetype: string;
  size: number;
  path?: string;
  buffer?: Buffer;
}

async function readContent(file: IncomingFile): Promise<Buffer> {
  if (file.buffer !== undefined) return file.buffer;
  if (file.path !== undefined) return readFile(file.path);
  return Buffer.alloc(0);
}

// The activity page only looks back 30 days; older rows are dead weight.
const UPLOAD_TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function removeTempFiles(files: IncomingFile[]): Promise<void> {
  await Promise.all(
    files.map((file) => (file.path ? unlink(file.path).catch(() => undefined) : undefined)),
  );
}

@Injectable()
export class UploadService {
  constructor(
    private readonly gatewayProvider: PaperlessGatewayProvider,
    @Inject(SETTINGS) private readonly settings: Settings,
    @Inject(DB) private readonly db: Database,
  ) {}

  async uploadAll(files: IncomingFile[], title?: string): Promise<UploadResponse> {
    try {
      return await this.uploadEach(files, title);
    } finally {
      await removeTempFiles(files);
    }
  }

  private async uploadEach(files: IncomingFile[], title?: string): Promise<UploadResponse> {
    const gateway = this.gatewayProvider.require();
    const results: UploadResult[] = [];

    for (const file of files) {
      const filename = file.originalname || "(unknown)";
      try {
        const contentType = (file.mimetype || "").toLowerCase().trim();
        if (!UPLOAD_ALLOWED_CONTENT_TYPES.has(contentType)) {
          results.push({
            filename,
            status: "error",
            detail: `Unsupported content-type: ${contentType || "unknown"}`,
          });
          continue;
        }
        if (file.size === 0) {
          results.push({ filename, status: "error", detail: "Empty file" });
          continue;
        }
        if (file.size > this.settings.UPLOAD_MAX_FILE_BYTES) {
          results.push({
            filename,
            status: "error",
            detail: `File too large (> ${this.settings.UPLOAD_MAX_FILE_BYTES} bytes)`,
          });
          continue;
        }
        const taskId = await gateway.uploadDocument({
          content: await readContent(file),
          filename: file.originalname || "document",
          contentType: file.mimetype,
          title,
        });
        results.push({ filename, status: "accepted", task_id: taskId });
        await this.recordTask(taskId, filename);
      } catch (error: unknown) {
        if (error instanceof PaperlessAuthError) throw error;
        logger.warn("upload_failed", {
          filename,
          error: error instanceof Error ? error.message : String(error),
        });
        results.push({
          filename,
          status: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { results };
  }

  /**
   * Best-effort: lets /api/ingest/activity tell uploads from e-mail. A
   * failure here must never turn an accepted upload into an error.
   */
  private async recordTask(taskId: string | null | undefined, filename: string): Promise<void> {
    if (!taskId) return;
    try {
      await this.db
        .insert(uploadTasks)
        .values({ taskId, fileName: filename.slice(0, 255) })
        .onConflictDoNothing();
      const cutoff = new Date(Date.now() - UPLOAD_TASK_RETENTION_MS).toISOString();
      await this.db.delete(uploadTasks).where(lt(uploadTasks.createdAt, cutoff));
    } catch (error: unknown) {
      logger.warn("upload_task_record_failed", {
        task_id: taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
