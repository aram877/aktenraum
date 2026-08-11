import { TYPE_FIELD_SCHEMA } from "@aktenraum/core-ts";
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthenticatedRequest } from "../auth/auth.guard.js";
import { verifyToken } from "../auth/jwt.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { SETTINGS, type Settings } from "../config/settings.js";
import { TypeFieldsService, validateFieldNames } from "./type-fields.service.js";

export const typeFieldsPatchSchema = z.object({
  fields: z.record(z.string().nullable()),
  document_type: z.string().nullable().optional(),
});
export type TypeFieldsPatch = z.infer<typeof typeFieldsPatchSchema>;

export interface TypeFieldsResponse {
  document_type: string;
  fields: Record<string, string>;
}

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

@Controller()
export class TypeFieldsController {
  constructor(
    private readonly typeFieldsService: TypeFieldsService,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  @Get("document-types/schema")
  @UseGuards(AuthGuard)
  @Header("Cache-Control", "private, max-age=3600")
  getSchema(): Record<string, { name: string; label_de: string; field_type: string }[]> {
    const out: Record<string, { name: string; label_de: string; field_type: string }[]> = {};
    for (const [docType, fields] of Object.entries(TYPE_FIELD_SCHEMA)) {
      out[docType] = fields.map((f) => ({
        name: f.name,
        label_de: f.labelDe,
        field_type: f.fieldType,
      }));
    }
    return out;
  }

  @Get("documents/:doc_id/type-fields")
  @UseGuards(AuthGuard)
  async getTypeFields(
    @Param("doc_id", ParseIntPipe) docId: number,
  ): Promise<TypeFieldsResponse> {
    const row = await this.typeFieldsService.get(docId);
    if (row === null) throw new NotFoundException("No type-specific fields found");
    return { document_type: row.documentType, fields: row.fields };
  }

  @Patch("documents/:doc_id/type-fields")
  async patchTypeFields(
    @Param("doc_id", ParseIntPipe) docId: number,
    @Body(new ZodValidationPipe(typeFieldsPatchSchema)) body: TypeFieldsPatch,
    @Headers("x-aktenraum-secret") secret: string | undefined,
    @Req() request: AuthenticatedRequest,
  ): Promise<TypeFieldsResponse> {
    this.requireUserOrSecret(request, secret);
    const docTypeStr =
      body.document_type ?? (await this.typeFieldsService.inferDocumentType(docId));
    const unknown = validateFieldNames(docTypeStr, body.fields);
    if (unknown.length > 0) {
      throw new HttpException(
        `Unknown fields for type '${docTypeStr}': ${JSON.stringify(unknown)}`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const row = await this.typeFieldsService.upsert(docId, body.fields, docTypeStr);
    return { document_type: row.documentType, fields: row.fields };
  }

  private requireUserOrSecret(
    request: AuthenticatedRequest,
    secret: string | undefined,
  ): void {
    if (secret !== undefined && this.settings.WEBHOOK_SECRET) {
      if (secretsMatch(secret, this.settings.WEBHOOK_SECRET)) return;
      throw new UnauthorizedException("Invalid secret");
    }
    const token: unknown = request.cookies?.[this.settings.COOKIE_NAME];
    if (typeof token !== "string" || token === "") {
      throw new UnauthorizedException("Not authenticated");
    }
    if (verifyToken(token, { secret: this.settings.JWT_SECRET }) === null) {
      throw new UnauthorizedException("Invalid session");
    }
  }
}
