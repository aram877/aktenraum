import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { TypeSpecificFieldsSection } from "../components/TypeSpecificFieldsSection";

import { Nav } from "../components/Nav";
import { NeighborNav } from "../components/NeighborNav";
import { DocumentMarkers } from "../components/DocumentMarkers";
import { DuplicateNotice } from "../components/DuplicateNotice";
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
import { useKeyboardShortcuts } from "../lib/keyboard";
import { useLibrary } from "../lib/library";
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
  const neighbors = useLibrary({ page_size: 100, ordering: "-created" });

  const [form, setForm] = useState<FormState>(detailToForm(undefined));
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    setConfirmingDelete(false);
  }, [id]);
  const [reprocessedAt, setReprocessedAt] = useState<Date | null>(null);
  const [mobilePane, setMobilePane] = useState<"pdf" | "form">("form");
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

  const neighborIds = neighbors.data?.results.map((r) => r.id) ?? [];
  const neighborPos = neighborIds.indexOf(id);
  const neighborTotal = neighborIds.length;
  const canNavigate = neighborTotal > 1;

  const advance = (direction: "next" | "prev") => {
    if (
      isDirty &&
      !window.confirm("Ungespeicherte Änderungen verwerfen?")
    ) {
      return;
    }
    if (neighborIds.length === 0) return;
    const filtered = neighborIds.filter((d) => d !== id);
    if (filtered.length === 0) {
      void navigate({ to: "/library" });
      return;
    }
    const currentPos = neighborIds.indexOf(id);
    let target: number | undefined;
    if (currentPos === -1) {
      target =
        direction === "next" ? filtered[0] : filtered[filtered.length - 1];
    } else if (direction === "next") {
      target =
        filtered.find((d) => neighborIds.indexOf(d) > currentPos) ??
        filtered[0];
    } else {
      const before = filtered.filter(
        (d) => neighborIds.indexOf(d) < currentPos,
      );
      target = before.length
        ? before[before.length - 1]
        : filtered[filtered.length - 1];
    }
    if (target !== undefined) {
      void navigate({
        to: "/library/$id",
        params: { id: String(target) },
      });
    }
  };

  useKeyboardShortcuts(
    {
      j: () => advance("next"),
      k: () => advance("prev"),
      Escape: () => void navigate({ to: "/library" }),
    },
    detail.isSuccess,
  );

  const paneTabCls = (key: "pdf" | "form") =>
    `flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
      mobilePane === key
        ? "bg-ink text-on-inverse"
        : "bg-surface text-ink-muted hover:text-ink"
    }`;

  return (
    <div className="flex min-h-full flex-col">
      <Nav active="library" />
      <main className="flex-1 px-4 py-3 md:px-6 md:py-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => window.history.back()}
              className="text-sm text-ink-muted hover:text-ink"
            >
              ← Zurück zur Bibliothek
            </button>
            <NeighborNav
              position={neighborPos}
              total={neighborTotal}
              canNavigate={canNavigate}
              onPrev={() => advance("prev")}
              onNext={() => advance("next")}
            />
          </div>
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
          <>
            <div className="mb-3 flex gap-1 rounded-md border border-hairline bg-canvas p-1 lg:hidden">
              <button
                type="button"
                onClick={() => setMobilePane("form")}
                className={paneTabCls("form")}
              >
                Bearbeiten
              </button>
              <button
                type="button"
                onClick={() => setMobilePane("pdf")}
                className={paneTabCls("pdf")}
              >
                PDF
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,2fr)]">
              <iframe
                key={id}
                title={`Vorschau ${id}`}
                src={`/api/documents/${id}/preview`}
                className={`h-[calc(100vh-200px)] w-full rounded-lg border border-hairline bg-surface lg:h-[80vh] ${
                  mobilePane === "pdf" ? "" : "hidden lg:block"
                }`}
              />

            <section
              className={`flex max-h-[calc(100vh-200px)] flex-col overflow-hidden rounded-lg border border-hairline bg-surface lg:h-[80vh] lg:max-h-none ${
                mobilePane === "form" ? "" : "hidden lg:flex"
              }`}
            >
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
                    {detail.data.created && (
                      <span title="Dokumentdatum">
                        Dok.: {detail.data.created}
                      </span>
                    )}
                    {detail.data.added && (
                      <span title="Hinzugefügt am (Posteingang in der Bibliothek)">
                        Hinzugefügt: {detail.data.added}
                      </span>
                    )}
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
                <DocumentMarkers
                  docId={detail.data.id}
                  tags={detail.data.tags}
                  className="shrink-0"
                />
              </header>

              <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
                <ErrorBanner
                  tags={detail.data.tags}
                  message={detail.data.ai_error_message}
                />
                <DuplicateNotice
                  docId={detail.data.id}
                  enabled={detail.data.tags.includes("ai-duplicate")}
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
                    documentType={
                      form.ai_document_type !== detail.data.ai_document_type
                        ? form.ai_document_type
                        : null
                    }
                    fallbackDocumentType={detail.data.ai_document_type}
                    // Poll for pass-2 results when the doc looks
                    // freshly-processed: either it carries an in-flight
                    // lifecycle tag, OR the user just triggered Erneut
                    // verarbeiten. Once the values land, the hook
                    // self-stops.
                    pollUntilArrived={
                      reprocessedAt !== null ||
                      detail.data.tags.includes("ai-pending") ||
                      detail.data.tags.includes("ai-approved")
                    }
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

              <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-hairline px-3 py-2.5">
                <a
                  href={`/api/documents/${id}/download`}
                  title="Download"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-hairline text-ink-subtle hover:bg-canvas hover:text-ink sm:h-auto sm:w-auto sm:p-1.5"
                >
                  <DownloadIcon className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                </a>

                {!confirmingDelete && (
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(true)}
                    disabled={deleteDoc.isPending}
                    title="In den Papierkorb verschieben (30 Tage wiederherstellbar)"
                    className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-hairline text-ink-subtle hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:opacity-50 sm:h-auto sm:w-auto sm:p-1.5"
                  >
                    <TrashIcon className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                  </button>
                )}
                {confirmingDelete && (
                  <div className="flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-900">
                    <span className="font-medium">In den Papierkorb?</span>
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

                <span className="mx-1 hidden h-4 w-px bg-hairline sm:inline" />

                <button
                  type="button"
                  onClick={onReprocess}
                  disabled={reprocess.isPending || patch.isPending}
                  title="Erneut verarbeiten — KI neu klassifizieren"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-hairline text-ink-subtle hover:border-amber-200 hover:bg-amber-50 hover:text-amber-800 disabled:opacity-50 sm:h-auto sm:w-auto sm:p-1.5"
                >
                  <RefreshIcon className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                </button>

                <button
                  type="button"
                  onClick={onReset}
                  disabled={!isDirty || patch.isPending}
                  title="Änderungen zurücksetzen"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-hairline text-ink-subtle hover:bg-canvas hover:text-ink disabled:opacity-40 sm:h-auto sm:w-auto sm:p-1.5"
                >
                  <UndoIcon className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                </button>

                <button
                  type="button"
                  onClick={onSave}
                  disabled={!isDirty || patch.isPending}
                  title="Speichern"
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-ink px-3 py-2 text-sm font-medium text-on-inverse hover:opacity-80 disabled:opacity-50 sm:flex-initial sm:px-3 sm:py-1.5 sm:text-xs"
                >
                  <CheckIcon className="h-3.5 w-3.5 sm:h-3 sm:w-3" />
                  {patch.isPending ? "…" : "Speichern"}
                </button>
              </footer>
            </section>
            </div>
          </>
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
          autoComplete="off"
          className={inputCls}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
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
