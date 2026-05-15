import { useState } from "react";

import { Nav } from "../components/Nav";
import type { LLMQuality } from "../lib/settings";
import { useLLMSettings, useUpdateLLMSettings } from "../lib/settings";

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

export function SettingsPage() {
  const current = useLLMSettings();
  const update = useUpdateLLMSettings();
  const [pending, setPending] = useState<LLMQuality | null>(null);

  const activeQuality = current.data?.quality ?? null;

  const onPick = async (value: LLMQuality) => {
    if (value === activeQuality) return;
    setPending(value);
    try {
      await update.mutateAsync(value);
    } finally {
      setPending(null);
    }
  };

  const errorDetail =
    current.error?.message || update.error?.message || null;

  return (
    <div className="flex min-h-full flex-col">
      <Nav active="settings" />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
        <h1 className="text-lg font-semibold tracking-tight">Einstellungen</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Wähle das KI-Modell für Klassifikation und Antwort. Die Auswahl wirkt
          sofort auf die nächste Extraktion — kein Container-Restart nötig.
        </p>

        {errorDetail && (
          <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorDetail}
          </p>
        )}

        <section className="mt-6 space-y-3">
          {OPTIONS.map((opt) => {
            const checked = activeQuality === opt.value;
            const isPending = pending === opt.value;
            return (
              <label
                key={opt.value}
                className={`block cursor-pointer rounded-md border px-4 py-3 transition-colors ${
                  checked
                    ? "border-neutral-900 bg-neutral-50"
                    : "border-neutral-200 bg-white hover:bg-neutral-50"
                }`}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="llm-quality"
                    value={opt.value}
                    checked={checked}
                    onChange={() => onPick(opt.value)}
                    disabled={update.isPending}
                    className="mt-1 h-4 w-4 accent-neutral-900"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-semibold text-neutral-900">
                        {opt.label}
                      </span>
                      <code className="text-[11px] text-neutral-500">
                        {opt.model}
                      </code>
                      {isPending && (
                        <span className="text-[11px] text-neutral-500">
                          speichere…
                        </span>
                      )}
                      {checked && !isPending && (
                        <span className="text-[11px] font-medium text-emerald-700">
                          aktiv
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-neutral-600">{opt.hint}</p>
                  </div>
                </div>
              </label>
            );
          })}
        </section>

        <p className="mt-6 text-xs text-neutral-500">
          Beide Modelle müssen auf dem Host mit{" "}
          <code className="rounded bg-neutral-100 px-1 py-0.5">ollama pull</code>{" "}
          installiert sein. Die Einstellung wirkt nur auf den
          <code className="ml-1 rounded bg-neutral-100 px-1 py-0.5">
            ollama
          </code>{" "}
          Backend — Anthropic nutzt weiterhin{" "}
          <code className="rounded bg-neutral-100 px-1 py-0.5">
            ANTHROPIC_MODEL
          </code>{" "}
          aus der Env.
        </p>
      </main>
    </div>
  );
}
