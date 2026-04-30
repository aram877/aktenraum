import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { Nav } from "../components/Nav";
import type { InboxFieldUpdate } from "../lib/inbox";
import {
  useApprove,
  useInboxDetail,
  useInboxList,
  useReject,
} from "../lib/inbox";
import { useKeyboardShortcuts } from "../lib/keyboard";

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
  "Bescheid",
  "Behördenbrief",
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
  ai_issue_date: string;
  ai_due_date: string;
  ai_expiry_date: string;
  ai_monetary_amount: string;
  ai_reference_numbers: string;
  ai_suggested_tags: string;
  ai_summary_de: string;
};

const EMPTY_FORM: FormState = {
  ai_document_type: "",
  ai_correspondent: "",
  ai_issue_date: "",
  ai_due_date: "",
  ai_expiry_date: "",
  ai_monetary_amount: "",
  ai_reference_numbers: "",
  ai_suggested_tags: "",
  ai_summary_de: "",
};

export function InboxReview({ id }: { id: number }) {
  const navigate = useNavigate();
  const detail = useInboxDetail(id);
  const list = useInboxList({ pageSize: 50 });
  const approve = useApprove(id);
  const reject = useReject(id);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [initialised, setInitialised] = useState<number | null>(null);

  // Hydrate the form once the detail query resolves; reset when the doc id changes.
  useEffect(() => {
    if (detail.data && initialised !== detail.data.id) {
      setForm({
        ai_document_type: detail.data.ai_document_type ?? "",
        ai_correspondent: detail.data.ai_correspondent ?? "",
        ai_issue_date: detail.data.ai_issue_date ?? "",
        ai_due_date: detail.data.ai_due_date ?? "",
        ai_expiry_date: detail.data.ai_expiry_date ?? "",
        ai_monetary_amount: detail.data.ai_monetary_amount ?? "",
        ai_reference_numbers: detail.data.ai_reference_numbers ?? "",
        ai_suggested_tags: detail.data.ai_suggested_tags ?? "",
        ai_summary_de: detail.data.ai_summary_de ?? "",
      });
      setInitialised(detail.data.id);
    }
  }, [detail.data, initialised]);

  const dirtyPatch = useMemo<InboxFieldUpdate>(() => {
    if (!detail.data) return {};
    const out: InboxFieldUpdate = {};
    const cmp = (
      key: keyof FormState,
      original: string | null | undefined,
    ) => {
      const v = form[key].trim();
      const orig = (original ?? "").trim();
      if (v !== orig) out[key] = v === "" ? null : v;
    };
    cmp("ai_document_type", detail.data.ai_document_type);
    cmp("ai_correspondent", detail.data.ai_correspondent);
    cmp("ai_issue_date", detail.data.ai_issue_date);
    cmp("ai_due_date", detail.data.ai_due_date);
    cmp("ai_expiry_date", detail.data.ai_expiry_date);
    cmp("ai_monetary_amount", detail.data.ai_monetary_amount);
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
      target = direction === "next" ? filtered[0] : filtered[filtered.length - 1];
    } else if (direction === "next") {
      target = filtered.find((d) => ids.indexOf(d) > currentPos) ?? filtered[0];
    } else {
      const before = filtered.filter((d) => ids.indexOf(d) < currentPos);
      target = before.length ? before[before.length - 1] : filtered[filtered.length - 1];
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
      // surface via approve.error below
    }
  };

  const onReject = async () => {
    try {
      await reject.mutateAsync();
      advance("next");
    } catch {
      // surface via reject.error below
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
          <Link to="/inbox" className="text-sm text-neutral-600 hover:text-neutral-900">
            ← Zurück zur Inbox
          </Link>
          <span className="text-xs text-neutral-500">
            Tasten: <kbd className="rounded bg-neutral-200 px-1">A</kbd> Genehmigen ·{" "}
            <kbd className="rounded bg-neutral-200 px-1">R</kbd> Ablehnen ·{" "}
            <kbd className="rounded bg-neutral-200 px-1">J</kbd>/
            <kbd className="rounded bg-neutral-200 px-1">K</kbd> Weiter/Zurück ·{" "}
            <kbd className="rounded bg-neutral-200 px-1">Esc</kbd> Liste
          </span>
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
              src={`/api/inbox/${id}/preview`}
              className="h-[80vh] w-full rounded-md border border-neutral-200 bg-white"
            />
            <section className="flex h-[80vh] flex-col overflow-hidden rounded-md border border-neutral-200 bg-white">
              <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{detail.data.title}</div>
                  <div className="text-xs text-neutral-500">
                    {detail.data.created ?? "—"} ·{" "}
                    {detail.data.ai_confidence != null
                      ? `${Math.round(detail.data.ai_confidence * 100)}% Konfidenz`
                      : "Konfidenz unbekannt"}
                  </div>
                </div>
                {detail.data.low_confidence && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                    Niedrige Konfidenz
                  </span>
                )}
              </header>

              <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
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
                <div className="grid grid-cols-3 gap-2">
                  <Field
                    label="Ausstellung"
                    type="date"
                    value={form.ai_issue_date}
                    onChange={(v) => setForm({ ...form, ai_issue_date: v })}
                  />
                  <Field
                    label="Fällig"
                    type="date"
                    value={form.ai_due_date}
                    onChange={(v) => setForm({ ...form, ai_due_date: v })}
                  />
                  <Field
                    label="Ablauf"
                    type="date"
                    value={form.ai_expiry_date}
                    onChange={(v) => setForm({ ...form, ai_expiry_date: v })}
                  />
                </div>
                <Field
                  label="Betrag"
                  value={form.ai_monetary_amount}
                  onChange={(v) => setForm({ ...form, ai_monetary_amount: v })}
                  placeholder="EUR149.99"
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

                <div className="rounded-md bg-neutral-50 p-3 text-xs text-neutral-600">
                  <div>
                    <span className="text-neutral-500">Backend:</span>{" "}
                    {detail.data.ai_backend ?? "—"} · {detail.data.ai_model ?? "—"}
                  </div>
                  <div className="mt-1">
                    <span className="text-neutral-500">Tags:</span>{" "}
                    {detail.data.tags.length ? detail.data.tags.join(", ") : "—"}
                  </div>
                </div>
              </div>

              {errorDetail && (
                <p className="border-t border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
                  {errorDetail}
                </p>
              )}

              <footer className="flex items-center justify-end gap-2 border-t border-neutral-200 px-4 py-3">
                <button
                  type="button"
                  onClick={onReject}
                  disabled={reject.isPending || approve.isPending}
                  className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-100 disabled:opacity-60"
                >
                  Ablehnen
                </button>
                <button
                  type="button"
                  onClick={onApprove}
                  disabled={reject.isPending || approve.isPending}
                  className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60"
                >
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
