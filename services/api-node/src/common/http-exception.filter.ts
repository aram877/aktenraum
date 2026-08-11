import { logger } from "@aktenraum/core-ts";
import {
  type ArgumentsHost,
  Catch,
  ConflictException,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  NotFoundException,
} from "@nestjs/common";
import type { Response } from "express";

import {
  PaperlessAuthError,
  PaperlessConflictError,
  PaperlessNotFoundError,
} from "../paperless/errors.js";

function toDetail(payload: unknown): unknown {
  if (typeof payload === "string") return payload;
  if (payload !== null && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if ("detail" in record) return record.detail;
    if ("message" in record) return record.message;
  }
  return payload;
}

function translate(exception: unknown): HttpException | null {
  if (exception instanceof PaperlessNotFoundError) {
    return new NotFoundException(`Document ${exception.docId} not found`);
  }
  if (exception instanceof PaperlessAuthError) {
    return new HttpException("Paperless rejected the API token", HttpStatus.BAD_GATEWAY);
  }
  if (exception instanceof PaperlessConflictError) {
    return new ConflictException(
      `Document ${exception.docId} was modified concurrently — refresh and try again`,
    );
  }
  return null;
}

@Catch()
export class FastApiErrorShapeFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const mapped = exception instanceof HttpException ? exception : translate(exception);

    if (mapped !== null) {
      if (response.headersSent) return;
      response.status(mapped.getStatus()).json({ detail: toDetail(mapped.getResponse()) });
      return;
    }

    logger.error("unhandled_exception", {
      error: exception instanceof Error ? exception.message : String(exception),
      stack: exception instanceof Error ? exception.stack : undefined,
    });
    if (response.headersSent) return;
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ detail: "Internal Server Error" });
  }
}
