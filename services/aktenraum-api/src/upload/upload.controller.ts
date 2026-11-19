import {
  BadRequestException,
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
import { UploadService, type IncomingFile, type UploadResponse } from "./upload.service.js";

const MAX_FILES_HARD_CAP = 100;

@Controller("documents")
@UseGuards(AuthGuard)
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly gateways: MemberGateways,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  @Post("upload")
  @RequireScope("upload")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FilesInterceptor("files", MAX_FILES_HARD_CAP))
  uploadDocuments(
    @UploadedFiles() files: IncomingFile[] | undefined,
    @CurrentPrincipal() principal: Principal,
    @Body("title") title?: string,
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
    return this.uploadService.uploadAll(principal, files, title);
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
