import { TYPE_FIELD_SCHEMA } from "@aktenraum/core";
import {
  Body,
  Controller,
  Get,
  Header,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";

import { AuthGuard } from "../auth/auth.guard.js";
import { DocumentAccess, RequireScope } from "../auth/principal.js";
import { UserOrInternalGuard } from "../auth/internal.guard.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
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

@Controller()
export class TypeFieldsController {
  constructor(private readonly typeFieldsService: TypeFieldsService) {}

  @Get("document-types/schema")
  @RequireScope("documents:read")
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
  @RequireScope("documents:read")
  @DocumentAccess("read")
  @UseGuards(AuthGuard)
  async getTypeFields(
    @Param("doc_id", ParseIntPipe) docId: number,
  ): Promise<TypeFieldsResponse> {
    const row = await this.typeFieldsService.get(docId);
    if (row === null) throw new NotFoundException("No type-specific fields found");
    return { document_type: row.documentType, fields: row.fields };
  }

  // The worker (secret) and the library/inbox detail pages (session) both write here.
  @Patch("documents/:doc_id/type-fields")
  @RequireScope("documents:write", "internal:type-fields-write")
  @DocumentAccess("edit-fields")
  @UseGuards(UserOrInternalGuard)
  async patchTypeFields(
    @Param("doc_id", ParseIntPipe) docId: number,
    @Body(new ZodValidationPipe(typeFieldsPatchSchema)) body: TypeFieldsPatch,
  ): Promise<TypeFieldsResponse> {
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
}
