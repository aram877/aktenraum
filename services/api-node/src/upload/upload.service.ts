import { logger } from "@aktenraum/core-ts";
import { Inject, Injectable } from "@nestjs/common";

import { SETTINGS, type Settings } from "../config/settings.js";
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
  buffer: Buffer;
}

@Injectable()
export class UploadService {
  constructor(
    private readonly gatewayProvider: PaperlessGatewayProvider,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  async uploadAll(files: IncomingFile[], title?: string): Promise<UploadResponse> {
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
        if (file.buffer.length === 0) {
          results.push({ filename, status: "error", detail: "Empty file" });
          continue;
        }
        if (file.buffer.length > this.settings.UPLOAD_MAX_FILE_BYTES) {
          results.push({
            filename,
            status: "error",
            detail: `File too large (> ${this.settings.UPLOAD_MAX_FILE_BYTES} bytes)`,
          });
          continue;
        }
        const taskId = await gateway.uploadDocument({
          content: file.buffer,
          filename: file.originalname || "document",
          contentType: file.mimetype,
          title,
        });
        results.push({ filename, status: "accepted", task_id: taskId });
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
}
