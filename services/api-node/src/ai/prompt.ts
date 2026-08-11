import type { ChatMessage } from "@aktenraum/core-ts";

import { detectIntents, docTypesForIntents } from "./intent.js";
import { moduleFor } from "./prompt-modules.js";

const DOC_TYPE_HINTS: ReadonlyArray<readonly [string, string]> = [
  ["Rechnung", "Rechnungen / Forderungen zur Zahlung (noch nicht bezahlt)"],
  ["Gehaltsabrechnung", "Lohn-/Gehaltsabrechnungen, Bezügemitteilungen"],
  ["Kontoauszug", "Bank-, Kreditkarten-, Sparkontoauszüge"],
  ["Nebenkostenabrechnung", "Mieter-seitige Nebenkostenabrechnung"],
  ["Hausgeldabrechnung", "Eigentümer-seitige WEG-Jahresabrechnung"],
  ["Mahnung", "Zahlungserinnerungen, Inkasso"],
  ["Vertrag", "Mietvertrag, Arbeitsvertrag, Service-Vertrag"],
  ["Kündigung", "Kündigungsschreiben jeder Art"],
  ["Versicherung", "Versicherungspolicen, -bescheinigungen"],
  [
    "Steuer",
    "Steuererklärungen, Steuerformulare, Anlagen — NICHT Lohnsteuerbescheinigung",
  ],
  ["Lohnsteuerbescheinigung", "Jährliche Lohnsteuerbescheinigung (§41b EStG)"],
  ["Spendenbescheinigung", "Zuwendungsbestätigung (§50 EStDV)"],
  ["Bescheid", "Behördenbescheide nicht-steuerlicher Art (außer Bußgeld)"],
  [
    "Behördenbrief",
    "Sonstige Behördenkorrespondenz (inkl. Einwohnermeldebescheinigung)",
  ],
  [
    "Sozialversicherungsmeldung",
    "Meldebescheinigung zur Sozialversicherung / SV-Jahresmeldung",
  ],
  ["Kfz", "Fahrzeugschein, Zulassung, TÜV-Bericht"],
  ["Bußgeldbescheid", "Bußgeld-/Verwarngeldbescheid wegen Verkehrsverstoß"],
  ["Arztbrief", "Arztberichte, Befunde, Rezepte"],
  ["Krankschreibung", "AU-Bescheinigung / gelber Schein"],
  ["Garantie", "Garantieurkunden, Gewährleistungen"],
  ["Urkunde", "Geburts-, Heirats-, Sterbeurkunden"],
  ["Ausweis", "Personalausweis, Reisepass, Führerschein"],
  ["Zeugnis", "Schul-, Hochschulzeugnisse"],
  ["Arbeitszeugnis", "Arbeits- und Praktikumszeugnisse"],
  ["Mitgliedschaft", "Mitgliedsbescheinigungen, Vereinsausweise"],
  [
    "Beleg",
    "Zahlungsbestätigung / Quittung / Kassenbon / Receipt — beweist BEZAHLT (im Gegensatz zur Rechnung)",
  ],
  ["Sonstiges", "Alles andere ohne klare Kategorie"],
];

const MAX_CORRESPONDENTS = 200;
const MAX_TAGS = 200;

const FEW_SHOT_EXAMPLES: ReadonlyArray<
  readonly [string, Record<string, unknown>]
> = [
  [
    "Lohnabrechnungen aus 2023",
    {
      document_type: "Gehaltsabrechnung",
      date_from: "2023-01-01",
      date_to: "2023-12-31",
    },
  ],
  [
    "Wie viel habe ich in 2025 verdient?",
    {
      document_type: "Gehaltsabrechnung",
      date_from: "2025-01-01",
      date_to: "2025-12-31",
    },
  ],
  ["Rechnungen von Telekom", { document_type: "Rechnung", correspondent: "Telekom" }],
  [
    "Verträge im ersten Quartal 2024",
    {
      document_type: "Vertrag",
      date_from: "2024-01-01",
      date_to: "2024-03-31",
    },
  ],
  [
    "Steuerbescheide aus 2023",
    {
      document_type: "Steuer",
      date_from: "2023-01-01",
      date_to: "2023-12-31",
    },
  ],
  ["Mein Lebenslauf", { tags: ["Lebenslauf"] }],
];

export function buildMessages(
  query: string,
  options: { correspondents: string[]; tags: string[] },
): ChatMessage[] {
  const system = buildSystemPrompt(
    query,
    options.correspondents,
    options.tags ?? [],
  );
  return [
    { role: "system", content: system },
    { role: "user", content: query },
  ];
}

function buildSystemPrompt(
  query: string,
  correspondents: string[],
  tags: string[],
): string {
  const parts: string[] = [];
  parts.push(
    "Du bist ein Suchassistent für ein deutsches Dokumentenmanagementsystem. " +
      "Deine Aufgabe: eine deutschsprachige Suchanfrage in einen strukturierten Filter " +
      "übersetzen. Antworte ausschließlich mit gültigem JSON nach dem vorgegebenen Schema.",
  );
  parts.push("Dokumenttypen (genau einer aus dieser Liste oder null):");
  for (const [name, hint] of DOC_TYPE_HINTS) {
    parts.push(`- ${name}: ${hint}`);
  }

  parts.push("Bekannte Korrespondenten (nutze einen exakten Namen oder null):");
  const truncated = correspondents.slice(0, MAX_CORRESPONDENTS);
  parts.push(truncated.length > 0 ? truncated.join(", ") : "(keine bekannt)");

  parts.push(
    "Bekannte Tags (frei wählbar, mehrere möglich; Liste leer lassen wenn " +
      "keiner passt). Tags helfen besonders, wenn der Dokumenttyp unklar ist " +
      "(z. B. ein Lebenslauf wird oft als 'Arbeitszeugnis' erkannt — der Tag " +
      "'Lebenslauf' ist dann zuverlässiger):",
  );
  const truncatedTags = tags.slice(0, MAX_TAGS);
  parts.push(truncatedTags.length > 0 ? truncatedTags.join(", ") : "(keine bekannt)");

  parts.push("Datumsregeln:");
  parts.push("- 'aus 2023' → date_from=2023-01-01, date_to=2023-12-31");
  parts.push("- 'Januar 2024' → date_from=2024-01-01, date_to=2024-01-31");
  parts.push("- 'Q1 2024' → date_from=2024-01-01, date_to=2024-03-31");
  parts.push("- 'letzten Monat' / 'aktueller Monat' → relativ zu heute interpretieren");
  parts.push(`- Heute ist ${todayIso()}`);

  parts.push(
    "Hinweis zu Beträgen: Dieser Filter hat KEINE betragsbezogenen Felder. " +
      "Beträge in der Anfrage (z. B. 'über 3000 €') ggf. als Freitext in `text` " +
      "aufnehmen oder ignorieren. Bevorzuge typspezifische Felder zur " +
      "späteren Verfeinerung über das UI.",
  );

  parts.push(
    "Freitextregel: Begriffe ohne strukturelle Bedeutung (Stichworte, " +
      "Inhaltsfragmente) gehören in das Feld `text`. Bevorzuge passende Tags " +
      "gegenüber Freitext.",
  );

  parts.push("Beispiele:");
  for (const [q, f] of FEW_SHOT_EXAMPLES) {
    parts.push(`Beispiel: Anfrage='${q}' → ${formatFilterExample(f)}`);
  }

  for (const [q, f] of intentExamples(query)) {
    parts.push(`Beispiel: Anfrage='${q}' → ${formatFilterExample(f)}`);
  }

  return parts.join("\n");
}

function intentExamples(query: string): [string, Record<string, unknown>][] {
  const intents = detectIntents(query);
  if (intents.size === 0) {
    return [];
  }
  const out: [string, Record<string, unknown>][] = [];
  const seen = new Set<string>();
  for (const dt of docTypesForIntents(intents)) {
    for (const [question, filterDict] of moduleFor(dt).filterExamples) {
      if (seen.has(question)) {
        continue;
      }
      seen.add(question);
      out.push([question, filterDict]);
    }
  }
  return out;
}

function formatFilterExample(f: Record<string, unknown>): string {
  return jsonDumps(f);
}

function jsonDumps(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => jsonDumps(item)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${JSON.stringify(k)}: ${jsonDumps(v)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  return JSON.stringify(value);
}

function todayIso(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
