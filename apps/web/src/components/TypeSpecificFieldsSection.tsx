import { useEffect, useMemo, useState } from "react";

import {
  useDocumentTypeSchema,
  usePatchTypeFields,
  useTypeFields,
  type FieldDef,
} from "../lib/typeFields";

const INPUT_CLS =
  "mt-1 block w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm focus:border-neutral-900 focus:outline-none";

function FieldInput({
  def,
  value,
  onChange,
}: {
  def: FieldDef;
  value: string;
  onChange: (v: string) => void;
}) {
  const placeholder =
    def.field_type === "money"
      ? "EUR0.00"
      : def.field_type === "year"
        ? "YYYY"
        : undefined;

  const inputType =
    def.field_type === "date"
      ? "date"
      : def.field_type === "month"
        ? "month"
        : "text";

  return (
    <label className="block text-xs font-medium text-neutral-600">
      {def.label_de}
      <input
        type={inputType}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={def.field_type === "year" ? 4 : undefined}
        className={INPUT_CLS}
      />
    </label>
  );
}

export function TypeSpecificFieldsSection({
  docId,
  documentType,
  fallbackDocumentType,
}: {
  docId: number;
  // Explicit user override: set when the dropdown was changed but not yet saved.
  // Null/undefined means "no explicit change — use DB or Paperless value".
  documentType: string | null | undefined;
  // Paperless-persisted type — last resort when there's no override and no DB row yet.
  fallbackDocumentType?: string | null;
}) {
  const schemaQuery = useDocumentTypeSchema();
  const typeFieldsQuery = useTypeFields(docId);
  const patch = usePatchTypeFields(docId);

  const schema = schemaQuery.data;

  // Priority: explicit dropdown change > our DB's saved type > Paperless value.
  // This ensures previously saved type-specific fields stay visible even when the
  // main form's ai_document_type hasn't been saved to Paperless yet.
  const dbDocumentType = typeFieldsQuery.data?.document_type ?? null;
  const effectiveDocumentType =
    documentType || dbDocumentType || fallbackDocumentType || null;

  const fields: FieldDef[] =
    effectiveDocumentType && schema ? (schema[effectiveDocumentType] ?? []) : [];

  const savedValues = useMemo<Record<string, string>>(() => {
    if (!typeFieldsQuery.data?.fields) return {};
    return typeFieldsQuery.data.fields;
  }, [typeFieldsQuery.data]);

  const [form, setForm] = useState<Record<string, string>>({});

  // Sync form when saved values reload or the doc changes.
  // Not driven by documentType: handleSave already filters payload to current fields,
  // so stale keys from a previous type don't need to be purged eagerly here.
  useEffect(() => {
    setForm(savedValues);
  }, [savedValues, docId]);

  const isDirty = useMemo(() => {
    return fields.some(
      (f) => (form[f.name] ?? "") !== (savedValues[f.name] ?? ""),
    );
  }, [form, savedValues, fields]);

  if (!effectiveDocumentType || fields.length === 0) return null;

  function handleSave() {
    const payload: Record<string, string | null> = {};
    for (const f of fields) {
      const v = (form[f.name] ?? "").trim();
      payload[f.name] = v || null;
    }
    patch.mutate({ fields: payload, documentType: effectiveDocumentType ?? undefined });
  }

  function handleReset() {
    setForm(savedValues);
  }

  return (
    <div className="border-t border-neutral-200 pt-4 mt-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        Typ-spezifische Felder
      </div>
      <div className="grid lg:grid-cols-2 gap-x-4 gap-y-3">
        {fields.map((def) => (
          <FieldInput
            key={def.name}
            def={def}
            value={form[def.name] ?? ""}
            onChange={(v) => setForm((prev) => ({ ...prev, [def.name]: v }))}
          />
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <button
          onClick={handleSave}
          disabled={!isDirty || patch.isPending}
          className="rounded-md bg-neutral-900 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-40"
        >
          {patch.isPending ? "Speichern…" : "Speichern"}
        </button>
        <button
          onClick={handleReset}
          disabled={!isDirty}
          className="rounded-md border border-neutral-300 bg-white px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-40"
        >
          Zurücksetzen
        </button>
      </div>
    </div>
  );
}
