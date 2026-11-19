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
import { MemberGateways } from "../tenancy/member-gateways.js";

import type { Response } from "express";

import type { DocumentSummary } from "../ai/ai.schemas.js";
import { projectResults } from "../ai/translate.js";
import { AuthGuard } from "../auth/auth.guard.js";
import { DocumentAccess, RequireScope, CurrentPrincipal, type Principal } from "../auth/principal.js";
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
  type ReprocessFailedResponse,
  type ReprocessResponse,
  type TaskStatusResponse,
} from "./documents.service.js";

@Controller("documents")
@UseGuards(AuthGuard)
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly inboxService: InboxService,
    private readonly gateways: MemberGateways,
  ) {}

  @Get("in-flight")
  @RequireScope("documents:read")
  inFlight(@CurrentPrincipal() principal: Principal): Promise<InFlightCount> {
    return this.documentsService.inFlightCount(principal);
  }

  @Get("processing")
  @RequireScope("documents:read")
  processing(): Promise<ProcessingStateResponse> {
    return this.documentsService.processingState();
  }

  @Get("task/:task_id")
  @RequireScope("documents:read")
  taskStatus(@CurrentPrincipal() principal: Principal, @Param("task_id") taskId: string): Promise<TaskStatusResponse> {
    return this.documentsService.taskStatus(principal, taskId);
  }

  @Post("reprocess-failed")
  @RequireScope("documents:write")
  @HttpCode(HttpStatus.OK)
  reprocessFailed(@CurrentPrincipal() principal: Principal): Promise<ReprocessFailedResponse> {
    return this.documentsService.reprocessFailed(principal);
  }

  @Get(":doc_id/status")
  @RequireScope("documents:read")
  @DocumentAccess("read")
  documentStatus(
    @CurrentPrincipal() principal: Principal,
    @Param("doc_id", ParseIntPipe) docId: number,
  ): Promise<DocumentStatusResponse> {
    return this.documentsService.documentStatus(principal, docId);
  }

  @Post(":doc_id/reprocess")
  @RequireScope("documents:write")
  @DocumentAccess("write")
  @HttpCode(HttpStatus.OK)
  reprocess(@CurrentPrincipal() principal: Principal, @Param("doc_id", ParseIntPipe) docId: number): Promise<ReprocessResponse> {
    return this.documentsService.reprocess(principal, docId);
  }

  @Post(":doc_id/dismiss-duplicate")
  @RequireScope("documents:write")
  @DocumentAccess("write")
  @HttpCode(HttpStatus.OK)
  dismissDuplicate(@CurrentPrincipal() principal: Principal, @Param("doc_id", ParseIntPipe) docId: number): Promise<DocIdResponse> {
    return this.documentsService.dismissDuplicate(principal, docId);
  }

  @Post(":doc_id/star")
  @RequireScope("documents:write")
  @DocumentAccess("write")
  @HttpCode(HttpStatus.OK)
  star(@CurrentPrincipal() principal: Principal, @Param("doc_id", ParseIntPipe) docId: number): Promise<DocIdResponse> {
    return this.documentsService.star(principal, docId);
  }

  @Delete(":doc_id/star")
  @RequireScope("documents:write")
  @DocumentAccess("write")
  @HttpCode(HttpStatus.OK)
  unstar(@CurrentPrincipal() principal: Principal, @Param("doc_id", ParseIntPipe) docId: number): Promise<DocIdResponse> {
    return this.documentsService.unstar(principal, docId);
  }

  @Get(":doc_id/duplicate-candidates")
  @RequireScope("documents:read")
  @DocumentAccess("read")
  async duplicateCandidates(
    @CurrentPrincipal() principal: Principal,
    @Param("doc_id", ParseIntPipe) docId: number,
  ): Promise<{ doc_id: number; candidates: DocumentSummary[] }> {
    const result = await this.documentsService.duplicateCandidates(principal, docId);
    if (result.matchedIds.size === 0) return { doc_id: docId, candidates: [] };
    const gateway = await this.gateways.forPrincipal(principal);
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
  @RequireScope("documents:read")
  @DocumentAccess("read")
  getDocumentDetail(@CurrentPrincipal() principal: Principal, @Param("doc_id", ParseIntPipe) docId: number): Promise<InboxDetail> {
    return this.inboxService.getDetail(principal, docId);
  }

  @Patch(":doc_id/fields")
  @RequireScope("documents:write")
  @DocumentAccess("write")
  patchDocumentFields(
    @CurrentPrincipal() principal: Principal,
    @Param("doc_id", ParseIntPipe) docId: number,
    @Body(new ZodValidationPipe(inboxFieldUpdateSchema)) body: InboxFieldUpdate,
  ): Promise<InboxDetail> {
    return this.inboxService.applyFieldUpdate(principal, docId, body);
  }

  @Get(":doc_id/preview")
  @RequireScope("documents:read")
  @DocumentAccess("read")
  async getPreview(
    @CurrentPrincipal() principal: Principal,
    @Param("doc_id", ParseIntPipe) docId: number,
    @Res() response: Response,
  ): Promise<void> {
    const upstream = await this.documentsService.openStream(principal, docId, "preview");
    const contentType = upstream.headers.get("content-type") ?? "application/pdf";
    const headers: Record<string, string> = { "Cache-Control": "private, max-age=300" };
    if (!inlineSafe(contentType)) {
      headers["Content-Disposition"] = "attachment";
      headers["Content-Security-Policy"] = "sandbox";
    }
    await pipeUpstreamToResponse(upstream, response, { contentType, headers });
  }

  @Get(":doc_id/download")
  @RequireScope("documents:read")
  @DocumentAccess("read")
  async getDownload(
    @CurrentPrincipal() principal: Principal,
    @Param("doc_id", ParseIntPipe) docId: number,
    @Res() response: Response,
  ): Promise<void> {
    const upstream = await this.documentsService.openStream(principal, docId, "download");
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
