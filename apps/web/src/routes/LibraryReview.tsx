import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { TypeSpecificFieldsSection } from "../components/TypeSpecificFieldsSection";

import { Nav } from "../components/Nav";
import { ProcessingBadge } from "../components/ProcessingBadge";
import type { DocumentDetail, DocumentFieldUpdate } from "../lib/documents";
import {
  useDeleteDocument,
  useDocumentDetail,
  useDocumentFieldsPatch,
  useReprocess,
} from "../lib/documents";

const DOC_TYPES = [
  "Rechnung",
  "Gehaltsabrechnung",
  "Kontoauszug",
  "Nebenkostenabrechnung",
  "Mahnung",
  "Vertrag",
  "Kündigung",
  "Versicherung",
  "Steuer",
  "Lohnsteuerbescheinigung",
  "Bescheid",
  "Behördenbrief",
  "Sozialversicherungsmeldung",
  "Kfz",
  "Arztbrief",
  "Garantie",
  "Urkunde",
  "Ausweis",
  "Zeugnis",
  "Arbeitszeugnis",
  "Mitgliedschaft",
  "Sonstiges",
] as const;

type FormState = {
  ai_document_type: string;
  ai_correspondent: string;
  ai_title: string;
  ai_issue_date: string;
  ai_reference_numbers: string;
  ai_suggested_tags: string;
  ai_summary_de: string;
};

function detailToForm(d: DocumentDetail | undefined): FormState {
  return {
    ai_document_type: d?.ai_document_type ?? "",
    ai_correspondent: d?.ai_correspondent ?? "",
    ai_title: d?.ai_title ?? "",
    ai_issue_date: d?.ai_issue_date ?? "",
    ai_reference_numbers: d?.ai_reference_numbers ?? "",
    ai_suggested_tags: d?.ai_suggested_tags ?? "",
    ai_summary_de: d?.ai_summary_de ?? "",
  };
}

export function LibraryReview({ id }: { id: number }) {
  const navigate = useNavigate();
  const detail = useDocumentDetail(id);
  const patch = useDocumentFieldsPatch(id);
  const reprocess = useReprocess();
  const deleteDoc = useDeleteDocument();

  const [form, setForm] = useState<FormState>(detailToForm(undefined));
  const [initialised, setInitialised] = useState<number | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Hydrate the form once the detail resolves; reset when the doc id changes.
  useEffect(() => {
    if (detail.data && initialised !== detail.data.id) {
      setForm(detailToForm(detail.data));
      setInitialised(detail.data.id);
    }
  }, [detail.data, initialised]);

  // Re-hydrate after a successful save so the user sees the normalised values
  // (e.g. "01.12.2024" → "2024-12-01", any string-trunc on non-longtext fields).
  useEffect(() => {
    if (patch.isSuccess && patch.data) {
      setForm(detailToForm(patch.data));
    }
  }, [patch.isSuccess, patch.data]);

  const dirtyPatch = useMemo<DocumentFieldUpdate>(() => {
    if (!detail.data) return {};
    const out: DocumentFieldUpdate = {};
    const cmp = (key: keyof FormState, original: string | null | undefined) => {
      const v = form[key].trim();
      const orig = (original ?? "").trim();
      if (v !== orig) out[key] = v === "" ? null : v;
    };
    cmp("ai_document_type", detail.data.ai_document_type);
    cmp("ai_correspondent", detail.data.ai_correspondent);
    cmp("ai_title", detail.data.ai_title);
    cmp("ai_issue_date", detail.data.ai_issue_date);
    cmp("ai_reference_numbers", detail.data.ai_reference_numbers);
    cmp("ai_suggested_tags", detail.data.ai_suggested_tags);
    cmp("ai_summary_de", detail.data.ai_summary_de);
    return out;
  }, [form, detail.data]);

  const isDirty = Object.keys(dirtyPatch).length > 0;

  const onSave = async () => {
    if (!isDirty) return;
    try {
      await patch.mutateAsync(dirtyPatch);
    } catch {
      // surfaced via patch.error below
    }
  };

  const onReset = () => {
    setForm(detailToForm(detail.data));
  };

  const onReprocess = async () => {
    try {
      await reprocess.mutateAsync(id);
      // Reprocess pulls the doc out of /library and into /inbox; navigate back.
      void navigate({ to: "/library" });
    } catch {
      // surfaced via reprocess.error below
    }
  };

  const onDelete = async () => {
    try {
      await deleteDoc.mutateAsync(id);
      void navigate({ to: "/library" });
    } catch {
      // surfaced via deleteDoc.error below
    }
  };

  const errorDetail =
    patch.error?.response?.data?.detail ??
    patch.error?.message ??
    reprocess.error?.response?.data?.detail ??
    reprocess.error?.message ??
    deleteDoc.error?.response?.data?.detail ??
    deleteDoc.error?.message ??
    null;

  return (
    <div className="flex min-h-full flex-col">
      <Nav active="library" />
      <main className="flex-1 px-6 py-4">
        <div className="mb-3 flex items-center justify-between">
          <Link
            to="/library"
            className="text-sm text-neutral-600 hover:text-neutral-900"
          >
            ← Zurück zur Bibliothek
          </Link>
          {isDirty && (
            <span className="text-xs text-amber-700">
              Ungespeicherte Änderungen
            </span>
          )}
        </div>

        {detail.isError && (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            Konnte das Dokument nicht laden.
          </p>
        )}

        {detail.data && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <iframe
              key={id}
              title={`Vorschau ${id}`}
              src={`/api/documents/${id}/preview`}
              className="h-[80vh] w-full rounded-md border border-neutral-200 bg-white"
            />

            <section className="flex h-[80vh] flex-col overflow-hidden rounded-md border border-neutral-200 bg-white">
              <header className="flex items-start justify-between gap-3 border-b border-neutral-200 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">
                    {detail.data.ai_title || detail.data.title}
                  </div>
                  {detail.data.original_file_name &&
                    detail.data.original_file_name !==
                      (detail.data.ai_title || detail.data.title) && (
                      <div className="truncate text-[11px] text-neutral-400">
                        Original: {detail.data.original_file_name}
                      </div>
                    )}
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                    {detail.data.created && <span>{detail.data.created}</span>}
                    {detail.data.ai_confidence != null && (
                      <span>
                        {Math.round(detail.data.ai_confidence * 100)}% Konfidenz
                      </span>
                    )}
                    <ProcessingBadge tags={detail.data.tags} />
                  </div>
                </div>
              </header>

              <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
                <Field
                  label="Titel (KI-Vorschlag)"
                  value={form.ai_title}
                  onChange={(v) => setForm({ ...form, ai_title: v })}
                  placeholder="z.B. Rechnung Stadtwerke März 2024"
                />
                <Field
                  label="Dokumenttyp"
                  as="select"
                  value={form.ai_document_type}
                  onChange={(v) => setForm({ ...form, ai_document_type: v })}
                />
                <Field
                  label="Korrespondent"
                  value={form.ai_correspondent}
                  onChange={(v) => setForm({ ...form, ai_correspondent: v })}
                />
                <Field
                  label="Ausstellung"
                  type="date"
                  value={form.ai_issue_date}
                  onChange={(v) => setForm({ ...form, ai_issue_date: v })}
                />
                <Field
                  label="Referenznummern"
                  value={form.ai_reference_numbers}
                  onChange={(v) =>
                    setForm({ ...form, ai_reference_numbers: v })
                  }
                />
                <Field
                  label="Vorgeschlagene Tags"
                  value={form.ai_suggested_tags}
                  onChange={(v) => setForm({ ...form, ai_suggested_tags: v })}
                />
                <Field
                  label="Zusammenfassung"
                  as="textarea"
                  value={form.ai_summary_de}
                  onChange={(v) => setForm({ ...form, ai_summary_de: v })}
                />

                <div className="rounded-md bg-neutral-50 p-3 text-xs text-neutral-600">
                  <div>
                    <span className="text-neutral-500">Backend:</span>{" "}
                    {detail.data.ai_backend ?? "—"} ·{" "}
                    {detail.data.ai_model ?? "—"}
                  </div>
                  <div className="mt-1">
                    <span className="text-neutral-500">Tags:</span>{" "}
                    {detail.data.tags.length > 0
                      ? detail.data.tags.join(", ")
                      : "—"}
                  </div>
                  <p className="mt-2 text-[11px] leading-snug text-neutral-500">
                    Bearbeitungen ändern nur die KI-Felder. Wenn auch die
                    nativen Paperless-Felder (Korrespondent, Dokumenttyp, Datum)
                    neu geschrieben werden sollen, klicke „Erneut verarbeiten".
                  </p>
                  <TypeSpecificFieldsSection
                    docId={detail.data.id}
                    documentType={detail.data.ai_document_type}
                  />
                </div>
              </div>

              {errorDetail && (
                <p className="border-t border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
                  {errorDetail}
                </p>
              )}
              {patch.isSuccess && !isDirty && (
                <p className="border-t border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-800">
                  ✓ Gespeichert
                </p>
              )}

              <footer className="flex items-center justify-end gap-2 border-t border-neutral-200 px-4 py-3">
                <a
                  href={`/api/documents/${id}/download`}
                  className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-900 hover:bg-neutral-100"
                >
                  Download
                </a>
                {!confirmingDelete && (
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(true)}
                    disabled={deleteDoc.isPending}
                    className="rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                    title="Dokument unwiderruflich löschen"
                  >
                    Löschen
                  </button>
                )}
                {confirmingDelete && (
                  <div className="flex items-center gap-1 rounded-md border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-900">
                    <span>Wirklich löschen?</span>
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(false)}
                      disabled={deleteDoc.isPending}
                      className="rounded px-2 py-0.5 hover:bg-red-100"
                    >
                      Abbrechen
                    </button>
                    <button
                      type="button"
                      onClick={onDelete}
                      disabled={deleteDoc.isPending}
                      className="rounded bg-red-600 px-2 py-0.5 font-medium text-white hover:bg-red-700 disabled:opacity-60"
                    >
                      {deleteDoc.isPending ? "…" : "Ja, löschen"}
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  onClick={onReprocess}
                  disabled={reprocess.isPending || patch.isPending}
                  className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                  title="Lifecycle-Tags löschen, KI neu klassifizieren"
                >
                  Erneut verarbeiten
                </button>
                <button
                  type="button"
                  onClick={onReset}
                  disabled={!isDirty || patch.isPending}
                  className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
                >
                  Zurücksetzen
                </button>
                <button
                  type="button"
                  onClick={onSave}
                  disabled={!isDirty || patch.isPending}
                  className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60"
                >
                  {patch.isPending ? "…" : "Speichern"}
                </button>
              </footer>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  as,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  as?: "select" | "textarea";
  placeholder?: string;
}) {
  const inputCls =
    "mt-1 block w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm focus:border-neutral-900 focus:outline-none";
  return (
    <label className="block text-xs font-medium text-neutral-600">
      {label}
      {as === "select" ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={inputCls}
        >
          <option value="">—</option>
          {DOC_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      ) : as === "textarea" ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={5}
          placeholder={placeholder}
          className={inputCls}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={inputCls}
        />
      )}
    </label>
  );
}
