import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";

import type { Response } from "express";

import type { DocumentSummary } from "../ai/ai.schemas.js";
import { projectResults } from "../ai/translate.js";
import { AuthGuard } from "../auth/auth.guard.js";
import { PaperlessGatewayProvider } from "../paperless/paperless.module.js";
import { collectTagIds } from "../paperless/tag-ids.js";
import { inlineSafe, pipeUpstreamToResponse } from "../common/stream.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import {
  inboxFieldUpdateSchema,
  type InboxDetail,
  type InboxFieldUpdate,
} from "../inbox/inbox.schemas.js";
import { InboxService } from "../inbox/inbox.service.js";
import {
  BADGE_TAG_NAMES,
  DocumentsService,
  type DocIdResponse,
  type DocumentStatusResponse,
  type InFlightCount,
  type ProcessingStateResponse,
  type ReprocessResponse,
  type TaskStatusResponse,
} from "./documents.service.js";

@Controller("documents")
@UseGuards(AuthGuard)
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly inboxService: InboxService,
    private readonly gatewayProvider: PaperlessGatewayProvider,
  ) {}

  @Get("in-flight")
  inFlight(): Promise<InFlightCount> {
    return this.documentsService.inFlightCount();
  }

  @Get("processing")
  processing(): Promise<ProcessingStateResponse> {
    return this.documentsService.processingState();
  }

  @Get("task/:task_id")
  taskStatus(@Param("task_id") taskId: string): Promise<TaskStatusResponse> {
    return this.documentsService.taskStatus(taskId);
  }

  @Get(":doc_id/status")
  documentStatus(
    @Param("doc_id", ParseIntPipe) docId: number,
  ): Promise<DocumentStatusResponse> {
    return this.documentsService.documentStatus(docId);
  }

  @Post(":doc_id/reprocess")
  @HttpCode(HttpStatus.OK)
  reprocess(@Param("doc_id", ParseIntPipe) docId: number): Promise<ReprocessResponse> {
    return this.documentsService.reprocess(docId);
  }

  @Post(":doc_id/dismiss-duplicate")
  @HttpCode(HttpStatus.OK)
  dismissDuplicate(@Param("doc_id", ParseIntPipe) docId: number): Promise<DocIdResponse> {
    return this.documentsService.dismissDuplicate(docId);
  }

  @Post(":doc_id/star")
  @HttpCode(HttpStatus.OK)
  star(@Param("doc_id", ParseIntPipe) docId: number): Promise<DocIdResponse> {
    return this.documentsService.star(docId);
  }

  @Delete(":doc_id/star")
  @HttpCode(HttpStatus.OK)
  unstar(@Param("doc_id", ParseIntPipe) docId: number): Promise<DocIdResponse> {
    return this.documentsService.unstar(docId);
  }

  @Get(":doc_id/duplicate-candidates")
  async duplicateCandidates(
    @Param("doc_id", ParseIntPipe) docId: number,
  ): Promise<{ doc_id: number; candidates: DocumentSummary[] }> {
    const result = await this.documentsService.duplicateCandidates(docId);
    if (result.matchedIds.size === 0) return { doc_id: docId, candidates: [] };
    const gateway = this.gatewayProvider.require();
    const correspondents = await gateway.listCorrespondents();
    const documentTypes = await gateway.listDocumentTypes();
    const matched = result.rawCandidates.filter((c) => result.matchedIds.has(c.id));
    const tags = await gateway.listTagsCovering(collectTagIds(matched));
    const candidates = projectResults(
      matched,
      {
        correspondentById: new Map(Object.entries(correspondents).map(([n, i]) => [i, n])),
        documentTypeById: new Map(Object.entries(documentTypes).map(([n, i]) => [i, n])),
        tagNameById: new Map(Object.entries(tags).map(([n, i]) => [i, n])),
        lifecycleTagNames: BADGE_TAG_NAMES,
        errorFieldId: (await gateway.getCustomFieldIds()).ai_error_message ?? null,
      },
    );
    return { doc_id: docId, candidates };
  }

  @Get(":doc_id/detail")
  getDocumentDetail(@Param("doc_id", ParseIntPipe) docId: number): Promise<InboxDetail> {
    return this.inboxService.getDetail(docId);
  }

  @Patch(":doc_id/fields")
  patchDocumentFields(
    @Param("doc_id", ParseIntPipe) docId: number,
    @Body(new ZodValidationPipe(inboxFieldUpdateSchema)) body: InboxFieldUpdate,
  ): Promise<InboxDetail> {
    return this.inboxService.applyFieldUpdate(docId, body);
  }

  @Get(":doc_id/preview")
  async getPreview(
    @Param("doc_id", ParseIntPipe) docId: number,
    @Res() response: Response,
  ): Promise<void> {
    const upstream = await this.documentsService.openStream(docId, "preview");
    const contentType = upstream.headers.get("content-type") ?? "application/pdf";
    const headers: Record<string, string> = { "Cache-Control": "private, max-age=300" };
    if (!inlineSafe(contentType)) {
      headers["Content-Disposition"] = "attachment";
      headers["Content-Security-Policy"] = "sandbox";
    }
    await pipeUpstreamToResponse(upstream, response, { contentType, headers });
  }

  @Get(":doc_id/download")
  async getDownload(
    @Param("doc_id", ParseIntPipe) docId: number,
    @Res() response: Response,
  ): Promise<void> {
    const upstream = await this.documentsService.openStream(docId, "download");
    await pipeUpstreamToResponse(upstream, response, {
      contentType: upstream.headers.get("content-type") ?? "application/octet-stream",
      forwardHeaders: ["content-disposition"],
      headers: {
        "Cache-Control": "private, no-store",
        ...(inlineSafe(upstream.headers.get("content-type") ?? "")
          ? {}
          : { "Content-Security-Policy": "sandbox" }),
      },
    });
  }
}
