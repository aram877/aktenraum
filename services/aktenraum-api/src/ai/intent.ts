import type { DocumentType } from "@aktenraum/core";

export const INTENTS = [
  "salary",
  "spending",
  "tax",
  "insurance",
  "housing",
  "medical",
  "id_document",
  "car",
  "contract",
] as const;

export type Intent = (typeof INTENTS)[number];

const INTENT_KEYWORDS: ReadonlyArray<readonly [Intent, readonly string[]]> = [
  [
    "salary",
    [
      "verdien",
      "gehalt",
      "gehälter",
      "lohnabrechnung",
      "lohn",
      "nettolohn",
      "bruttolohn",
      "auszahlung",
    ],
  ],
  [
    "spending",
    ["ausgegeben", "kosten", "gekostet", "bezahlt", "preis", "rechnung"],
  ],
  ["tax", ["steuer", "erstattung", "finanzamt"]],
  [
    "insurance",
    ["versicherung", "prämie", "police", "selbstbeteiligung", "schadensfall"],
  ],
  ["housing", ["nebenkosten", "hausgeld", "miete", "vorauszahlung"]],
  [
    "medical",
    [
      "arzt",
      "diagnose",
      "krankschreibung",
      "krank",
      "au-bescheinigung",
      "arbeitsunfähig",
      "befund",
      "rezept",
    ],
  ],
  [
    "id_document",
    [
      "reisepass",
      "ausweis",
      "perso",
      "führerschein",
      "fuehrerschein",
      "ablauf",
      "abläuft",
      "verlängern",
      "verlaengern",
      "gültig",
      "pass",
    ],
  ],
  [
    "car",
    [
      "kfz",
      "tüv",
      "tuev",
      "hauptuntersuchung",
      "kennzeichen",
      "fahrgestell",
      "fahrgestellnummer",
      "fahrzeug",
    ],
  ],
  [
    "contract",
    ["vertrag", "kündigung", "kuendigung", "kündigen", "vertragsende"],
  ],
];

const STRICT_KEYWORDS: ReadonlySet<string> = new Set(["pass", "lohn"]);

export const INTENT_DOC_TYPES: Readonly<Record<Intent, readonly DocumentType[]>> = {
  salary: ["Gehaltsabrechnung"],
  spending: ["Rechnung", "Mahnung"],
  tax: ["Steuer", "Lohnsteuerbescheinigung"],
  insurance: ["Versicherung"],
  housing: ["Nebenkostenabrechnung", "Hausgeldabrechnung"],
  medical: ["Arztbrief", "Krankschreibung"],
  id_document: ["Ausweis"],
  car: ["Kfz"],
  contract: ["Vertrag", "Kündigung"],
};

const WORD_CHAR = "\\p{L}\\p{N}_";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STRICT_PATTERNS: ReadonlyMap<string, RegExp> = new Map(
  [...STRICT_KEYWORDS].map((kw) => [
    kw,
    new RegExp(
      `(?<![${WORD_CHAR}])${escapeRegExp(kw)}(?![${WORD_CHAR}])`,
      "u",
    ),
  ]),
);

function matches(haystack: string, keyword: string): boolean {
  const strict = STRICT_PATTERNS.get(keyword);
  if (strict) {
    return strict.test(haystack);
  }
  return haystack.includes(keyword);
}

export function detectIntents(question: string): Set<Intent> {
  const hits = new Set<Intent>();
  if (!question) {
    return hits;
  }
  const lowered = question.toLowerCase();
  for (const [intent, keywords] of INTENT_KEYWORDS) {
    for (const kw of keywords) {
      if (matches(lowered, kw)) {
        hits.add(intent);
        break;
      }
    }
  }
  return hits;
}

export function docTypesForIntents(intents: ReadonlySet<Intent>): DocumentType[] {
  const out: DocumentType[] = [];
  const seen = new Set<DocumentType>();
  for (const intent of INTENTS) {
    if (!intents.has(intent)) {
      continue;
    }
    for (const dt of INTENT_DOC_TYPES[intent]) {
      if (seen.has(dt)) {
        continue;
      }
      seen.add(dt);
      out.push(dt);
    }
  }
  return out;
}
