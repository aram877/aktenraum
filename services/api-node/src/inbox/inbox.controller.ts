import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { AuthGuard } from "../auth/auth.guard.js";
import { pipeUpstreamToResponse } from "../common/stream.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import {
  inboxFieldUpdateSchema,
  type InboxDetail,
  type InboxFieldUpdate,
  type InboxList,
} from "./inbox.schemas.js";
import { InboxService } from "./inbox.service.js";

const ORDERING_ALLOWLIST: ReadonlySet<string> = new Set([
  "-modified",
  "modified",
  "-created",
  "created",
  "-added",
  "added",
  "title",
  "-title",
]);

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

@Controller("inbox")
@UseGuards(AuthGuard)
export class InboxController {
  constructor(private readonly inboxService: InboxService) {}

  @Get()
  listInbox(
    @Query("page") page?: string,
    @Query("page_size") pageSize?: string,
    @Query("ordering") ordering?: string,
  ): Promise<InboxList> {
    return this.inboxService.listPending({
      page: clampInt(page, 1, 1, Number.MAX_SAFE_INTEGER),
      pageSize: clampInt(pageSize, 20, 1, 100),
      ordering:
        ordering !== undefined && ORDERING_ALLOWLIST.has(ordering) ? ordering : "-modified",
    });
  }

  @Get(":doc_id")
  getInboxDetail(@Param("doc_id", ParseIntPipe) docId: number): Promise<InboxDetail> {
    return this.inboxService.getDetail(docId);
  }

  @Patch(":doc_id")
  patchInbox(
    @Param("doc_id", ParseIntPipe) docId: number,
    @Body(new ZodValidationPipe(inboxFieldUpdateSchema)) body: InboxFieldUpdate,
  ): Promise<InboxDetail> {
    return this.inboxService.applyFieldUpdate(docId, body);
  }

  @Post(":doc_id/approve")
  @HttpCode(HttpStatus.OK)
  approveInbox(
    @Param("doc_id", ParseIntPipe) docId: number,
    @Body(new ZodValidationPipe(inboxFieldUpdateSchema.optional())) body?: InboxFieldUpdate,
  ): Promise<InboxDetail> {
    return this.inboxService.approve(docId, body ?? null);
  }

  @Post(":doc_id/reject")
  @HttpCode(HttpStatus.OK)
  rejectInbox(@Param("doc_id", ParseIntPipe) docId: number): Promise<InboxDetail> {
    return this.inboxService.reject(docId);
  }

  @Get(":doc_id/preview")
  async previewInbox(
    @Param("doc_id", ParseIntPipe) docId: number,
    @Res() response: Response,
  ): Promise<void> {
    const upstream = await this.inboxService.openPreview(docId);
    await pipeUpstreamToResponse(upstream, response, {
      contentType: "application/pdf",
      headers: { "Cache-Control": "private, max-age=300" },
    });
  }
}
