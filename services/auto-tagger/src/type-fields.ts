import {
  logger,
  TYPE_FIELD_SCHEMA,
  type ChatMessage,
  type DocumentType,
  type LLMBackend,
} from "@aktenraum/core";
import { z } from "zod";

const FIELD_TYPE_DESCRIPTIONS: Record<string, string> = {
  string: "Text",
  money: "Geldbetrag (z.B. '149,99 EUR' oder 'EUR 149.99')",
  date: "Datum (beliebiges Format — wird normalisiert)",
  month: "Monat (z.B. '01/2024' oder 'Januar 2024')",
  year: "Jahr (4-stellig, z.B. '2024')",
};

const OCR_RULE =
  "Hinweis: OCR-Text kann Ziffern durch Leerzeichen trennen " +
  "(z.B. '2 8. 0 2. 2 0 2 4' = '28.02.2024'). Lies solche Fragmente immer zusammen.";

const fieldValue = z
  .union([z.string(), z.number()])
  .nullable()
  .optional()
  .transform((value) => (value === null || value === undefined ? null : String(value).trim()));

export function typeFieldsSchema(docType: DocumentType) {
  return z.object(
    Object.fromEntries(TYPE_FIELD_SCHEMA[docType].map((field) => [field.name, fieldValue])),
  );
}

export function buildTypeFieldsMessages(docType: DocumentType, text: string): ChatMessage[] {
  const fields = TYPE_FIELD_SCHEMA[docType];
  const lines = fields
    .map((f) => `  - ${f.name} (${FIELD_TYPE_DESCRIPTIONS[f.fieldType] ?? "Text"}): ${f.labelDe}`)
    .join("\n");
  const system =
    `Du analysierst ein deutsches Dokument vom Typ '${docType}'.\n` +
    "Extrahiere ausschließlich die folgenden Felder und gib ein JSON-Objekt zurück.\n" +
    `Felder:\n${lines}\n\n` +
    "Regeln:\n" +
    "- Antworte NUR mit einem JSON-Objekt, ohne Erklärungen.\n" +
    "- Wenn ein Feld nicht im Dokument steht, setze es auf null. Erfinde keine Werte.\n" +
    `- ${OCR_RULE}\n`;
  return [
    { role: "system", content: system },
    { role: "user", content: `Dokumenttext:\n\n${text}` },
  ];
}

export async function extractTypeFields(
  backend: LLMBackend,
  docType: DocumentType,
  text: string,
): Promise<Record<string, string>> {
  if (TYPE_FIELD_SCHEMA[docType].length === 0) return {};
  const raw = (await backend.complete(
    buildTypeFieldsMessages(docType, text),
    typeFieldsSchema(docType),
  )) as Record<string, string | null>;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value) out[name] = value;
  }
  return out;
}

export type SaveTypeFields = (
  docId: number,
  docType: DocumentType,
  fields: Record<string, string>,
) => Promise<void>;

export function apiTypeFieldsSaver(
  apiUrl: string,
  webhookSecret: string,
  fetchFn: typeof fetch = fetch,
): SaveTypeFields {
  return async (docId, docType, fields) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (webhookSecret) headers["X-Aktenraum-Secret"] = webhookSecret;
    const resp = await fetchFn(
      `${apiUrl.replace(/\/+$/, "")}/api/documents/${docId}/type-fields`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ document_type: docType, fields }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!resp.ok) {
      throw new Error(`type-fields PATCH ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
  };
}

export async function runTypeFieldsPass(options: {
  docId: number;
  docType: DocumentType;
  text: string;
  backend: LLMBackend;
  save: SaveTypeFields;
}): Promise<void> {
  const { docId, docType } = options;
  if (TYPE_FIELD_SCHEMA[docType].length === 0) return;
  try {
    const fields = await extractTypeFields(options.backend, docType, options.text);
    if (Object.keys(fields).length === 0) {
      logger.info("type_specific_pass_empty", { doc_id: docId, doc_type: docType });
      return;
    }
    await options.save(docId, docType, fields);
    logger.info("type_specific_pass_done", {
      doc_id: docId,
      doc_type: docType,
      fields: Object.keys(fields),
    });
  } catch (error: unknown) {
    logger.warn("type_specific_pass_failed", {
      doc_id: docId,
      doc_type: docType,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
