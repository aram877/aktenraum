import {
  BadRequestException,
  ForbiddenException,
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  ParseIntPipe,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { MemberGateways } from "../tenancy/member-gateways.js";

import { AuthGuard } from "../auth/auth.guard.js";
import {
  CurrentPrincipal,
  DocumentAccess,
  RequireScope,
  type Principal,
} from "../auth/principal.js";
import { SETTINGS, type Settings } from "../config/settings.js";
import { SpacesService } from "../spaces/spaces.service.js";
import { UploadService, type IncomingFile, type UploadResponse } from "./upload.service.js";

const MAX_FILES_HARD_CAP = 100;

@Controller("documents")
@UseGuards(AuthGuard)
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly gateways: MemberGateways,
    private readonly spaces: SpacesService,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  @Post("upload")
  @RequireScope("upload")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FilesInterceptor("files", MAX_FILES_HARD_CAP))
  async uploadDocuments(
    @UploadedFiles() files: IncomingFile[] | undefined,
    @CurrentPrincipal() principal: Principal,
    @Body("title") title?: string,
    @Body("space_id") rawSpaceId?: string,
  ): Promise<UploadResponse> {
    if (files === undefined || files.length === 0) {
      throw new BadRequestException("No files supplied");
    }
    if (files.length > this.settings.UPLOAD_MAX_FILES_PER_REQUEST) {
      throw new HttpException(
        `Too many files in one upload (max ${this.settings.UPLOAD_MAX_FILES_PER_REQUEST}).`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    // Checked before anything reaches Paperless: only spaces where the
    // uploader is owner or editor (absent = their personal space).
    let spaceId: number | null = null;
    if (rawSpaceId !== undefined && rawSpaceId !== "") {
      spaceId = Number(rawSpaceId);
      if (!Number.isInteger(spaceId) || spaceId <= 0) {
        await this.uploadService.discard(files);
        throw new BadRequestException("space_id must be a positive integer");
      }
      if (principal.kind !== "member" || !(await this.spaces.canPlaceInto(principal.memberId, spaceId))) {
        await this.uploadService.discard(files);
        throw new ForbiddenException("In diese Akte darfst du nichts hochladen");
      }
    }
    return this.uploadService.uploadAll(principal, files, title, spaceId);
  }

  @Delete(":doc_id")
  @RequireScope("documents:delete")
  @DocumentAccess("delete")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteDocument(
    @CurrentPrincipal() principal: Principal,
    @Param("doc_id", ParseIntPipe) docId: number,
  ): Promise<void> {
    await (await this.gateways.forPrincipal(principal)).deleteDocument(docId);
  }
}
