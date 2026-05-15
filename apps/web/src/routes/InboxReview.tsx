import { useNavigate } from "@tanstack/react-router";
import { TypeSpecificFieldsSection } from "../components/TypeSpecificFieldsSection";
import { useEffect, useMemo, useRef, useState } from "react";

import { Nav } from "../components/Nav";
import { CheckIcon, XIcon } from "../components/Icons";
import type { InboxFieldUpdate } from "../lib/inbox";
import {
  useApprove,
  useInboxDetail,
  useInboxList,
  useReject,
} from "../lib/inbox";
import { useKeyboardShortcuts } from "../lib/keyboard";
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

const EMPTY_FORM: FormState = {
  ai_document_type: "",
  ai_correspondent: "",
  ai_title: "",
  ai_issue_date: "",
  ai_reference_numbers: "",
  ai_suggested_tags: "",
  ai_summary_de: "",
};

function detailToForm(d: {
  ai_document_type: string | null;
  ai_correspondent: string | null;
  ai_title: string | null;
  ai_issue_date: string | null;
  ai_reference_numbers: string | null;
  ai_suggested_tags: string | null;
  ai_summary_de: string | null;
  tags?: string[];
}): FormState {
  const suggestedRaw = (d.ai_suggested_tags ?? "").trim();
  const suggested = suggestedRaw || userFacingTags(d.tags ?? []).join(", ");
  return {
    ai_document_type: d.ai_document_type ?? "",
    ai_correspondent: d.ai_correspondent ?? "",
    ai_title: d.ai_title ?? "",
    ai_issue_date: d.ai_issue_date ?? "",
    ai_reference_numbers: d.ai_reference_numbers ?? "",
    ai_suggested_tags: suggested,
    ai_summary_de: d.ai_summary_de ?? "",
  };
}

export function InboxReview({ id }: { id: number }) {
  const navigate = useNavigate();
  const detail = useInboxDetail(id);
  const list = useInboxList({ pageSize: 50 });
  const approve = useApprove(id);
  const reject = useReject(id);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const lastHydratedRef = useRef<FormState | null>(null);
  const lastHydratedIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!detail.data) return;
    const next = detailToForm(detail.data);
    if (lastHydratedIdRef.current !== detail.data.id) {
      setForm(next);
      lastHydratedRef.current = next;
      lastHydratedIdRef.current = detail.data.id;
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

  const dirtyPatch = useMemo<InboxFieldUpdate>(() => {
    if (!detail.data) return {};
    const out: InboxFieldUpdate = {};
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

  const advance = (direction: "next" | "prev" = "next") => {
    const ids = list.data?.results.map((r) => r.id) ?? [];
    const filtered = ids.filter((d) => d !== id);
    if (filtered.length === 0) {
      void navigate({ to: "/inbox" });
      return;
    }
    const currentPos = ids.indexOf(id);
    let target: number | undefined;
    if (currentPos === -1) {
      target =
        direction === "next" ? filtered[0] : filtered[filtered.length - 1];
    } else if (direction === "next") {
      target =
        filtered.find((d) => ids.indexOf(d) > currentPos) ?? filtered[0];
    } else {
      const before = filtered.filter((d) => ids.indexOf(d) < currentPos);
      target =
        before.length
          ? before[before.length - 1]
          : filtered[filtered.length - 1];
    }
    if (target !== undefined) {
      void navigate({ to: "/inbox/$id", params: { id: String(target) } });
    } else {
      void navigate({ to: "/inbox" });
    }
  };

  const onApprove = async () => {
    const body = Object.keys(dirtyPatch).length ? dirtyPatch : undefined;
    try {
      await approve.mutateAsync(body);
      advance("next");
    } catch {
      // surfaced via approve.error below
    }
  };

  const onReject = async () => {
    try {
      await reject.mutateAsync();
      advance("next");
    } catch {
      // surfaced via reject.error below
    }
  };

  useKeyboardShortcuts(
    {
      a: onApprove,
      r: onReject,
      j: () => advance("next"),
      k: () => advance("prev"),
      Escape: () => void navigate({ to: "/inbox" }),
    },
    detail.isSuccess,
  );

  const errorDetail = approve.error?.message || reject.error?.message;

  return (
    <div className="flex min-h-full flex-col">
      <Nav active="inbox" />
      <main className="flex-1 px-6 py-4">
        <div className="mb-3 flex items-center justify-between">
          <button
            type="button"
            onClick={() => window.history.back()}
            className="text-sm text-ink-muted hover:text-ink"
          >
            ← Zur Prüfung
          </button>
          <span className="text-xs text-ink-subtle">
            Tasten:{" "}
            <kbd className="rounded border border-hairline bg-surface-raised px-1">A</kbd>{" "}
            Genehmigen ·{" "}
            <kbd className="rounded border border-hairline bg-surface-raised px-1">R</kbd>{" "}
            Ablehnen ·{" "}
            <kbd className="rounded border border-hairline bg-surface-raised px-1">J</kbd>/
            <kbd className="rounded border border-hairline bg-surface-raised px-1">K</kbd>{" "}
            Weiter/Zurück ·{" "}
            <kbd className="rounded border border-hairline bg-surface-raised px-1">Esc</kbd>{" "}
            Liste
          </span>
        </div>

        {detail.isError && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            Konnte das Dokument nicht laden.
          </p>
        )}

        {detail.data && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <iframe
              key={id}
              title={`Vorschau ${id}`}
              src={`/api/inbox/${id}/preview`}
              className="h-[80vh] w-full rounded-lg border border-hairline bg-surface"
            />
            <section className="flex h-[80vh] flex-col overflow-hidden rounded-lg border border-hairline bg-surface">
              <header className="flex items-center justify-between border-b border-hairline px-4 py-3">
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
                  <div className="text-xs text-ink-subtle">
                    {detail.data.created ?? "—"} ·{" "}
                    {detail.data.ai_confidence != null
                      ? `${Math.round(detail.data.ai_confidence * 100)}% Konfidenz`
                      : "Konfidenz unbekannt"}
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
                {detail.data.low_confidence && (
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                    Niedrige Konfidenz
                  </span>
                )}
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
                  onChange={(v) => setForm({ ...form, ai_reference_numbers: v })}
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
                    {detail.data.tags.length ? detail.data.tags.join(", ") : "—"}
                  </div>
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

              <footer className="flex items-center justify-end gap-1.5 border-t border-hairline px-4 py-2.5">
                <button
                  type="button"
                  onClick={onReject}
                  disabled={reject.isPending || approve.isPending}
                  title="Ablehnen (R)"
                  className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-canvas px-3 py-1.5 text-xs font-medium text-ink-muted hover:bg-surface-raised disabled:opacity-60"
                >
                  <XIcon className="h-3 w-3" />
                  Ablehnen
                </button>
                <button
                  type="button"
                  onClick={onApprove}
                  disabled={reject.isPending || approve.isPending}
                  title="Genehmigen (A)"
                  className="inline-flex items-center gap-1.5 rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-on-inverse hover:opacity-80 disabled:opacity-60"
                >
                  <CheckIcon className="h-3 w-3" />
                  {approve.isPending ? "…" : "Genehmigen"}
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
          rows={4}
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
