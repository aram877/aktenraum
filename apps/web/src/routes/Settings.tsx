import { useState } from "react";

import { useNavigate } from "@tanstack/react-router";

import { Nav } from "../components/Nav";
import { useChangePassword } from "../lib/auth";
import type { LLMQuality } from "../lib/settings";
import {
  useAnswerLLMSettings,
  useLLMSettings,
  useUpdateAnswerLLMSettings,
  useUpdateLLMSettings,
} from "../lib/settings";

type Option = {
  value: LLMQuality;
  label: string;
  model: string;
  hint: string;
};

const OPTIONS: Option[] = [
  {
    value: "high",
    label: "High",
    model: "gemma4:26b",
    hint:
      "Größeres lokales Modell — bessere Klassifikation und konsistentere Felder. " +
      "Braucht mehr RAM/VRAM, ein Dokument dauert spürbar länger.",
  },
  {
    value: "medium",
    label: "Medium",
    model: "qwen2.5vl:7b",
    hint:
      "Kleines, schnelles Modell. Schnellere Extraktion; einige Felder werden " +
      "öfter unvollständig oder weniger präzise.",
  },
];

function ModelPicker({
  title,
  description,
  radioName,
  activeQuality,
  isPending: isUpdatePending,
  onPick,
  pending,
}: {
  title: string;
  description: string;
  radioName: string;
  activeQuality: LLMQuality | null;
  isPending: boolean;
  onPick: (v: LLMQuality) => void;
  pending: LLMQuality | null;
}) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      <p className="mt-0.5 text-xs text-ink-muted">{description}</p>
      <div className="mt-3 space-y-3">
        {OPTIONS.map((opt) => {
          const checked = activeQuality === opt.value;
          const isPending = pending === opt.value;
          return (
            <label
              key={opt.value}
              className={`block cursor-pointer rounded-lg border px-5 py-4 transition-colors ${
                checked
                  ? "border-ink bg-surface"
                  : "border-hairline bg-surface hover:border-hairline-soft hover:bg-canvas"
              }`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  name={radioName}
                  value={opt.value}
                  checked={checked}
                  onChange={() => onPick(opt.value)}
                  disabled={isUpdatePending}
                  className="mt-1 h-4 w-4 accent-ink"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold text-ink">
                      {opt.label}
                    </span>
                    <code className="text-[11px] text-ink-subtle">
                      {opt.model}
                    </code>
                    {isPending && (
                      <span className="text-[11px] text-ink-subtle">
                        speichere…
                      </span>
                    )}
                    {checked && !isPending && (
                      <span className="text-[11px] font-medium text-emerald-700">
                        aktiv
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-ink-muted">{opt.hint}</p>
                </div>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function mapChangePasswordError(status: number | undefined): string {
  if (status === 401) return "Aktuelles Passwort ist nicht korrekt.";
  if (status === 400)
    return "Das neue Passwort muss sich vom aktuellen unterscheiden.";
  if (status === 422)
    return "Bitte fülle alle Felder korrekt aus (min. 8 Zeichen für das neue Passwort).";
  return "Unbekannter Fehler beim Ändern des Passworts.";
}

function KontoSection() {
  const navigate = useNavigate();
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showSuccess, setShowSuccess] = useState(false);

  const confirmMismatch = confirm.length > 0 && confirm !== next;
  const newTooShort = next.length > 0 && next.length < 8;
  const canSubmit =
    current.length > 0 &&
    next.length >= 8 &&
    next === confirm &&
    !change.isPending &&
    !showSuccess;

  const errorBanner = change.error
    ? mapChangePasswordError(change.error.response?.status)
    : null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    try {
      await change.mutateAsync({ currentPassword: current, newPassword: next });
      setCurrent("");
      setNext("");
      setConfirm("");
      setShowSuccess(true);
      setTimeout(() => {
        void navigate({ to: "/login" });
      }, 1500);
    } catch {
      // error already captured on the mutation's `error` field
    }
  }

  return (
    <div>
      <h2 className="text-sm font-semibold text-ink">Konto</h2>
      <p className="mt-0.5 text-xs text-ink-muted">
        Passwort ändern. Du wirst nach erfolgreicher Änderung neu angemeldet.
      </p>

      {showSuccess && (
        <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Passwort geändert — du wirst zum Login geleitet.
        </p>
      )}
      {errorBanner && !showSuccess && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorBanner}
        </p>
      )}

      <form onSubmit={onSubmit} className="mt-4 space-y-3" noValidate>
        <label className="block">
          <span className="text-xs font-medium text-ink-muted">
            Aktuelles Passwort
          </span>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            disabled={change.isPending || showSuccess}
            className="mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-ink-muted">
            Neues Passwort
          </span>
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            disabled={change.isPending || showSuccess}
            minLength={8}
            maxLength={128}
            className="mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
          />
          {newTooShort && (
            <span className="mt-1 block text-[11px] text-red-700">
              Mindestens 8 Zeichen.
            </span>
          )}
        </label>

        <label className="block">
          <span className="text-xs font-medium text-ink-muted">
            Neues Passwort bestätigen
          </span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            disabled={change.isPending || showSuccess}
            className="mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
          />
          {confirmMismatch && (
            <span className="mt-1 block text-[11px] text-red-700">
              Passwörter stimmen nicht überein.
            </span>
          )}
        </label>

        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-surface disabled:cursor-not-allowed disabled:opacity-50"
        >
          {change.isPending ? "speichere…" : "Passwort ändern"}
        </button>
      </form>
    </div>
  );
}

export function SettingsPage() {
  const tagger = useLLMSettings();
  const updateTagger = useUpdateLLMSettings();
  const [taggerPending, setTaggerPending] = useState<LLMQuality | null>(null);

  const answer = useAnswerLLMSettings();
  const updateAnswer = useUpdateAnswerLLMSettings();
  const [answerPending, setAnswerPending] = useState<LLMQuality | null>(null);

  const onPickTagger = async (value: LLMQuality) => {
    if (value === tagger.data?.quality) return;
    setTaggerPending(value);
    try {
      await updateTagger.mutateAsync(value);
    } finally {
      setTaggerPending(null);
    }
  };

  const onPickAnswer = async (value: LLMQuality) => {
    if (value === answer.data?.quality) return;
    setAnswerPending(value);
    try {
      await updateAnswer.mutateAsync(value);
    } finally {
      setAnswerPending(null);
    }
  };

  const errorDetail =
    tagger.error?.message ||
    updateTagger.error?.message ||
    answer.error?.message ||
    updateAnswer.error?.message ||
    null;

  return (
    <div className="flex min-h-full flex-col">
      <Nav active="settings" />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
        <h1 className="text-lg font-semibold tracking-tight text-ink">Einstellungen</h1>
        <p className="mt-1 text-sm text-ink-muted">
          KI-Modelle für Klassifikation und Antwort unabhängig wählen.
          Die Auswahl wirkt sofort — kein Container-Restart nötig.
        </p>

        {errorDetail && (
          <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorDetail}
          </p>
        )}

        <div className="mt-6 space-y-8">
          <KontoSection />

          <div className="border-t border-hairline" />

          <ModelPicker
            title="Klassifikations-Modell"
            description="Wird für die automatische Dokumentenextraktion verwendet (Typ, Felder, Datum)."
            radioName="llm-quality"
            activeQuality={tagger.data?.quality ?? null}
            isPending={updateTagger.isPending}
            onPick={onPickTagger}
            pending={taggerPending}
          />

          <div className="border-t border-hairline" />

          <ModelPicker
            title="Antwort-Modell (KI-Fragen)"
            description="Wird für Fragen auf der /Fragen-Seite verwendet. Ein größeres Modell liefert zuverlässigere Antworten und Summen."
            radioName="answer-llm-quality"
            activeQuality={answer.data?.quality ?? null}
            isPending={updateAnswer.isPending}
            onPick={onPickAnswer}
            pending={answerPending}
          />
        </div>

        <p className="mt-8 text-xs text-ink-subtle">
          Beide Modelle müssen auf dem Host mit{" "}
          <code className="rounded border border-hairline bg-surface-raised px-1 py-0.5">
            ollama pull
          </code>{" "}
          installiert sein. Die Einstellung wirkt nur auf den{" "}
          <code className="rounded border border-hairline bg-surface-raised px-1 py-0.5">
            ollama
          </code>{" "}
          Backend — Anthropic nutzt weiterhin{" "}
          <code className="rounded border border-hairline bg-surface-raised px-1 py-0.5">
            ANTHROPIC_MODEL
          </code>{" "}
          aus der Env.
        </p>
      </main>
    </div>
  );
}
