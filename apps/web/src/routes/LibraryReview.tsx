import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { TypeSpecificFieldsSection } from "../components/TypeSpecificFieldsSection";

import { Nav } from "../components/Nav";
import { ProcessingBadge } from "../components/ProcessingBadge";
import {
  CheckIcon,
  DownloadIcon,
  RefreshIcon,
  TrashIcon,
  UndoIcon,
} from "../components/Icons";
import type { DocumentDetail, DocumentFieldUpdate } from "../lib/documents";
import {
  isInFlight,
  useDeleteDocument,
  useDocumentDetail,
  useDocumentFieldsPatch,
  useProcessingState,
  useReprocess,
} from "../lib/documents";
import { userFacingTags } from "../lib/lifecycleTags";

const DOC_TYPES = [
  "Rechnung",
  "Gehaltsabrechnung",
  "Kontoauszug",
  "Nebenkostenabrechnung",
  "Hausgeldabrechnung",
  "Mahnung",
  "Vertrag",
  "Kündigung",
  "Versicherung",
  "Steuer",
  "Lohnsteuerbescheinigung",
  "Spendenbescheinigung",
  "Bescheid",
  "Behördenbrief",
  "Sozialversicherungsmeldung",
  "Kfz",
  "Bußgeldbescheid",
  "Arztbrief",
  "Krankschreibung",
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
  const suggestedRaw = (d?.ai_suggested_tags ?? "").trim();
  const suggested = suggestedRaw || userFacingTags(d?.tags ?? []).join(", ");
  return {
    ai_document_type: d?.ai_document_type ?? "",
    ai_correspondent: d?.ai_correspondent ?? "",
    ai_title: d?.ai_title ?? "",
    ai_issue_date: d?.ai_issue_date ?? "",
    ai_reference_numbers: d?.ai_reference_numbers ?? "",
    ai_suggested_tags: suggested,
    ai_summary_de: d?.ai_summary_de ?? "",
  };
}

export function LibraryReview({ id }: { id: number }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const detail = useDocumentDetail(id);
  const processing = useProcessingState();
  const patch = useDocumentFieldsPatch(id);
  const reprocess = useReprocess();
  const deleteDoc = useDeleteDocument();

  const [form, setForm] = useState<FormState>(detailToForm(undefined));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [reprocessedAt, setReprocessedAt] = useState<Date | null>(null);
  const lastHydratedRef = useRef<FormState | null>(null);
  const lastHydratedIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!detail.data) return;
    const next = detailToForm(detail.data);
    if (lastHydratedIdRef.current !== detail.data.id) {
      setForm(next);
      lastHydratedRef.current = next;
      lastHydratedIdRef.current = detail.data.id;
      setReprocessedAt(null);
      return;
    }
    const prev = lastHydratedRef.current;
    if (!prev) {
      setForm(next);
      lastHydratedRef.current = next;
      return;
    }
    setForm((current) => {
      const merged: FormState = { ...current };
      let changed = false;
      (Object.keys(next) as (keyof FormState)[]).forEach((k) => {
        if (current[k] === prev[k] && current[k] !== next[k]) {
          merged[k] = next[k];
          changed = true;
        }
      });
      return changed ? merged : current;
    });
    lastHydratedRef.current = next;
  }, [detail.data]);

  useEffect(() => {
    if (patch.isSuccess && patch.data) {
      const next = detailToForm(patch.data);
      setForm(next);
      lastHydratedRef.current = next;
    }
  }, [patch.isSuccess, patch.data]);

  useEffect(() => {
    if (!reprocessedAt) return;
    const stopAt = reprocessedAt.getTime() + 120_000;
    const tick = setInterval(() => {
      if (Date.now() > stopAt) {
        clearInterval(tick);
        return;
      }
      void qc.invalidateQueries({ queryKey: ["document-detail", id] });
    }, 5_000);
    return () => clearInterval(tick);
  }, [reprocessedAt, qc, id]);

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

  const onReset = () => setForm(detailToForm(detail.data));

  const onReprocess = async () => {
    try {
      await reprocess.mutateAsync(id);
      setReprocessedAt(new Date());
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
          <button
            type="button"
            onClick={() => window.history.back()}
            className="text-sm text-ink-muted hover:text-ink"
          >
            ← Zurück zur Bibliothek
          </button>
          {isDirty && (
            <span className="text-xs text-amber-700">
              Ungespeicherte Änderungen
            </span>
          )}
        </div>

        {detail.isError && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            Konnte das Dokument nicht laden.
          </p>
        )}

        {detail.data && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,2fr)]">
            <iframe
              key={id}
              title={`Vorschau ${id}`}
              src={`/api/documents/${id}/preview`}
              className="h-[80vh] w-full rounded-lg border border-hairline bg-surface"
            />

            <section className="flex h-[80vh] flex-col overflow-hidden rounded-lg border border-hairline bg-surface">
              <header className="flex items-start justify-between gap-3 border-b border-hairline px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-ink">
                    {detail.data.ai_title || detail.data.title}
                  </div>
                  {detail.data.original_file_name &&
                    detail.data.original_file_name !==
                      (detail.data.ai_title || detail.data.title) && (
                      <div className="truncate text-[11px] text-ink-faint">
                        Original: {detail.data.original_file_name}
                      </div>
                    )}
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-subtle">
                    {detail.data.created && <span>{detail.data.created}</span>}
                    {detail.data.ai_confidence != null && (
                      <span>
                        {Math.round(detail.data.ai_confidence * 100)}% Konfidenz
                      </span>
                    )}
                    <ProcessingBadge
                      tags={detail.data.tags}
                      errorMessage={detail.data.ai_error_message}
                      inFlight={isInFlight(id, processing.data)}
                    />
                  </div>
                  {detail.data.ai_confidence_reason && (
                    <div
                      className="mt-0.5 text-[11px] italic leading-snug text-ink-subtle"
                      title="Begründung der KI für den Konfidenzwert"
                    >
                      {detail.data.ai_confidence_reason}
                    </div>
                  )}
                </div>
              </header>

              <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
                <ErrorBanner
                  tags={detail.data.tags}
                  message={detail.data.ai_error_message}
                />
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

                <div className="rounded-lg border border-hairline bg-canvas p-3 text-xs text-ink-muted">
                  <div>
                    <span className="text-ink-subtle">Backend:</span>{" "}
                    {detail.data.ai_backend ?? "—"} ·{" "}
                    {detail.data.ai_model ?? "—"}
                  </div>
                  <div className="mt-1">
                    <span className="text-ink-subtle">Tags:</span>{" "}
                    {detail.data.tags.length > 0
                      ? detail.data.tags.join(", ")
                      : "—"}
                  </div>
                  <p className="mt-2 text-[11px] leading-snug text-ink-subtle">
                    Bearbeitungen ändern nur die KI-Felder. Wenn auch die
                    nativen Paperless-Felder neu geschrieben werden sollen,
                    klicke „Erneut verarbeiten".
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
              {reprocessedAt && (
                <p className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
                  ✓ KI-Analyse neu gestartet am{" "}
                  {reprocessedAt.toLocaleString("de-DE", {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}{" "}
                  Uhr · Status oben aktualisiert sich automatisch.
                </p>
              )}

              <footer className="flex items-center justify-end gap-1.5 border-t border-hairline px-4 py-2.5">
                {/* Left-side utility icons */}
                <a
                  href={`/api/documents/${id}/download`}
                  title="Download"
                  className="rounded-md border border-hairline p-1.5 text-ink-subtle hover:bg-canvas hover:text-ink"
                >
                  <DownloadIcon className="h-3.5 w-3.5" />
                </a>

                {!confirmingDelete && (
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(true)}
                    disabled={deleteDoc.isPending}
                    title="Dokument löschen"
                    className="rounded-md border border-hairline p-1.5 text-ink-subtle hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </button>
                )}
                {confirmingDelete && (
                  <div className="flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-900">
                    <span className="font-medium">Löschen?</span>
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(false)}
                      disabled={deleteDoc.isPending}
                      className="rounded px-1.5 py-0.5 hover:bg-red-100"
                    >
                      Nein
                    </button>
                    <button
                      type="button"
                      onClick={onDelete}
                      disabled={deleteDoc.isPending}
                      className="rounded bg-red-600 px-1.5 py-0.5 font-medium text-white hover:bg-red-700 disabled:opacity-60"
                    >
                      {deleteDoc.isPending ? "…" : "Ja"}
                    </button>
                  </div>
                )}

                {/* Divider */}
                <span className="mx-1 h-4 w-px bg-hairline" />

                <button
                  type="button"
                  onClick={onReprocess}
                  disabled={reprocess.isPending || patch.isPending}
                  title="Erneut verarbeiten — KI neu klassifizieren"
                  className="rounded-md border border-hairline p-1.5 text-ink-subtle hover:border-amber-200 hover:bg-amber-50 hover:text-amber-800 disabled:opacity-50"
                >
                  <RefreshIcon className="h-3.5 w-3.5" />
                </button>

                <button
                  type="button"
                  onClick={onReset}
                  disabled={!isDirty || patch.isPending}
                  title="Änderungen zurücksetzen"
                  className="rounded-md border border-hairline p-1.5 text-ink-subtle hover:bg-canvas hover:text-ink disabled:opacity-40"
                >
                  <UndoIcon className="h-3.5 w-3.5" />
                </button>

                <button
                  type="button"
                  onClick={onSave}
                  disabled={!isDirty || patch.isPending}
                  title="Speichern"
                  className="inline-flex items-center gap-1.5 rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-on-inverse hover:opacity-80 disabled:opacity-50"
                >
                  <CheckIcon className="h-3 w-3" />
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
    "mt-1 block w-full rounded-md border border-hairline bg-canvas px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none";
  return (
    <label className="block text-xs font-medium text-ink-muted">
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

function ErrorBanner({
  tags,
  message,
}: {
  tags: string[];
  message: string | null;
}) {
  const errorTags = tags.filter(
    (t) =>
      t === "ai-error" ||
      t === "ai-propagation-error" ||
      t === "ai-index-error",
  );
  if (errorTags.length === 0) return null;
  const label =
    errorTags[0] === "ai-propagation-error"
      ? "Übertragung fehlgeschlagen"
      : errorTags[0] === "ai-index-error"
        ? "RAG-Indizierung fehlgeschlagen"
        : "KI-Analyse fehlgeschlagen";
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs">
      <div className="font-semibold text-red-900">{label}</div>
      <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] leading-snug text-red-800">
        {(message ?? "").trim() ||
          "Kein Fehlertext gespeichert. Logs des auto-tagger oder propagator prüfen."}
      </pre>
      <div className="mt-1 text-[11px] text-red-700">
        Tag: <code>{errorTags.join(", ")}</code> · „Erneut verarbeiten" löscht
        die Lifecycle-Tags und stößt die KI neu an.
      </div>
    </div>
  );
}
