import {
  logger,
  normalizeDate,
  normalizeMonetary,
  TYPE_FIELD_SCHEMA,
  type DocumentType,
  type FieldType,
} from "@aktenraum/core";
import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";

import { DB, type Database } from "../db/db.module.js";
import { documentTypeFields } from "../db/schema.js";
import { parseDocumentType } from "../ai/prompt-modules.js";
import { PaperlessGatewayProvider } from "../paperless/paperless.module.js";

export interface DocumentTypeFieldsRow {
  paperlessDocId: number;
  documentType: string;
  fields: Record<string, string>;
}

const MONTHS_DE: Record<string, string> = {
  januar: "01",
  februar: "02",
  "märz": "03",
  maerz: "03",
  april: "04",
  mai: "05",
  juni: "06",
  juli: "07",
  august: "08",
  september: "09",
  oktober: "10",
  november: "11",
  dezember: "12",
};

export function normaliseMonth(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}$/.test(trimmed)) return trimmed;
  const slash = /^(\d{1,2})[./](\d{4})$/.exec(trimmed);
  if (slash !== null) return `${slash[2]}-${(slash[1] as string).padStart(2, "0")}`;
  const lower = trimmed.toLowerCase();
  for (const [name, num] of Object.entries(MONTHS_DE)) {
    if (lower.includes(name)) {
      const year = /\d{4}/.exec(trimmed);
      if (year !== null) return `${year[0]}-${num}`;
    }
  }
  return trimmed;
}

export function normaliseValue(value: string, fieldType: FieldType): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (fieldType === "money") return normalizeMonetary(trimmed) ?? trimmed;
  if (fieldType === "date") return normalizeDate(trimmed) ?? trimmed;
  if (fieldType === "month") return normaliseMonth(trimmed);
  if (fieldType === "year") {
    const digits = trimmed.replace(/\D/g, "");
    return digits.length >= 4 ? digits.slice(0, 4) : trimmed;
  }
  return trimmed.slice(0, 500);
}

export function validateFieldNames(
  docTypeStr: string | null | undefined,
  rawFields: Record<string, string | null>,
): string[] {
  const docType = parseDocumentType(docTypeStr);
  if (docType === null) return [];
  const valid = new Set(TYPE_FIELD_SCHEMA[docType].map((f) => f.name));
  return Object.keys(rawFields).filter((name) => !valid.has(name));
}

@Injectable()
export class TypeFieldsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly gatewayProvider: PaperlessGatewayProvider,
  ) {}

  async get(docId: number): Promise<DocumentTypeFieldsRow | null> {
    const rows = await this.db
      .select()
      .from(documentTypeFields)
      .where(eq(documentTypeFields.paperlessDocId, docId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      paperlessDocId: row.paperlessDocId,
      documentType: row.documentType,
      fields: (row.fields ?? {}) as Record<string, string>,
    };
  }

  async inferDocumentType(docId: number): Promise<string | null> {
    try {
      const gateway = this.gatewayProvider.require();
      const doc = await gateway.getDocument(docId);
      const nameToId = await gateway.getCustomFieldIds();
      const fieldIdToName = new Map(Object.entries(nameToId).map(([n, i]) => [i, n]));
      for (const cf of (doc.custom_fields as { field: number; value: unknown }[] | undefined) ??
        []) {
        if (fieldIdToName.get(cf.field) === "ai_document_type") {
          return typeof cf.value === "string" && cf.value !== "" ? cf.value : null;
        }
      }
    } catch (error: unknown) {
      logger.warn("type_fields_infer_doc_type_failed", {
        doc_id: docId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }

  async upsert(
    docId: number,
    rawFields: Record<string, string | null>,
    docTypeStr: string | null,
  ): Promise<DocumentTypeFieldsRow> {
    const resolvedType = docTypeStr ?? (await this.inferDocumentType(docId));
    const docType: DocumentType | null = parseDocumentType(resolvedType);
    const schemaFields = docType !== null ? TYPE_FIELD_SCHEMA[docType] : [];
    const fieldTypeByName = new Map(schemaFields.map((f) => [f.name, f.fieldType]));

    const normalised: Record<string, string> = {};
    for (const [name, value] of Object.entries(rawFields)) {
      if (value === null || value === undefined) continue;
      const cleaned = normaliseValue(value, fieldTypeByName.get(name) ?? "string");
      if (cleaned !== null) normalised[name] = cleaned;
    }

    const existing = await this.get(docId);
    if (existing === null) {
      await this.db.insert(documentTypeFields).values({
        paperlessDocId: docId,
        documentType: resolvedType ?? "",
        fields: normalised,
      });
      return { paperlessDocId: docId, documentType: resolvedType ?? "", fields: normalised };
    }

    let merged = { ...existing.fields };
    if (resolvedType && existing.documentType && existing.documentType !== resolvedType) {
      merged = Object.fromEntries(
        Object.entries(merged).filter(([name]) => fieldTypeByName.has(name)),
      );
    }
    Object.assign(merged, normalised);
    const documentType = resolvedType || existing.documentType;

    await this.db
      .update(documentTypeFields)
      .set({ fields: merged, documentType })
      .where(eq(documentTypeFields.paperlessDocId, docId));
    return { paperlessDocId: docId, documentType, fields: merged };
  }
}
