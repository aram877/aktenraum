import { DOCUMENT_TYPES, type DocumentType } from "@aktenraum/core";

import { detectIntents, docTypesForIntents } from "./intent.js";

/**
 * Deterministic, LLM-free reading of an Ask question (fast-ask D2). The hints only
 * narrow the *structured* search path; semantic and full-text candidates ignore them.
 */
export interface ParsedQuestion {
  /** ISO date (YYYY-MM-DD) or null. */
  dateFrom: string | null;
  dateTo: string | null;
  docTypes: DocumentType[];
  /** Known correspondent names (as stored in Paperless), at most `MAX_CORRESPONDENTS`. */
  correspondents: string[];
  /** The question without German stop words, for Paperless full-text search. */
  text: string;
  /** "letzte" / "neueste" / "aktuelle": the newest matching document is what is asked for. */
  newest: boolean;
}

export const MAX_CORRESPONDENTS = 3;
const MIN_TOKEN_LENGTH = 4;
/** A question word may extend a name token by this many letters ("Amazons", "Vattenfalls"). */
const MAX_INFLECTION = 2;

const MONTHS: Readonly<Record<string, number>> = {
  januar: 1,
  jänner: 1,
  februar: 2,
  märz: 3,
  maerz: 3,
  april: 4,
  mai: 5,
  juni: 6,
  juli: 7,
  august: 8,
  september: 9,
  oktober: 10,
  november: 11,
  dezember: 12,
};

/** Legal forms and filler that never identify a correspondent. */
const LEGAL_FORMS: ReadonlySet<string> = new Set([
  "gmbh",
  "mbh",
  "kg",
  "ag",
  "se",
  "ohg",
  "gbr",
  "ug",
  "ev",
  "eg",
  "kgaa",
  "co",
  "inc",
  "ltd",
  "llc",
  "sarl",
]);

/** Words too generic to pick a correspondent on their own ("Stadt", "Bank", "Versicherung"). */
const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  "stadt",
  "bank",
  "versicherung",
  "versicherungen",
  "deutsche",
  "deutscher",
  "deutsches",
  "gemeinde",
  "amt",
  "finanzamt",
  "kasse",
  "krankenkasse",
  "europa",
  "europe",
  "germany",
  "deutschland",
  "service",
  "services",
  "verwaltung",
  "gesellschaft",
  "group",
  "gruppe",
  "holding",
  "handel",
  "verein",
  "praxis",
  "dr",
]);

const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "aber alle allem allen aller alles also auch auf aus bei bin bis bist da damit dann das dass dein deine " +
    "dem den der des die dies diese diesem diesen dieser dieses doch dort du durch ein eine einem einen " +
    "einer eines er es etwa euch euer für gab gibt habe haben hast hat hatte hatten hier hin ich ihr ihre " +
    "im in ist ja jede jedem jeden jeder jedes jetzt kann kein keine mal man mehr mein meine meinem meinen " +
    "meiner meines mich mir mit muss nach nicht noch nun nur ob oder ohne sein seine sind so soll sollen " +
    "über um und uns unser unter vom von vor war waren warst was weil welche welchem welchen welcher " +
    "welches wenn wer werden wie wieder will wir wird wirst wo wollen zu zum zur zwischen " +
    "viel wann wieviel wie lange habe hatte letzte letzten letzter letztes letztem " +
    "gibt gab sagt steht stehen wurde wurden wäre"
  ).split(/\s+/),
);

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];
}

function parseDates(question: string, now: Date): { from: string | null; to: string | null } {
  let rest = question.toLowerCase();
  let from: string | null = null;
  let to: string | null = null;
  const widen = (start: string, end: string | null): void => {
    if (from === null || start < from) from = start;
    if (end !== null && (to === null || end > to)) to = end;
  };

  // "März 2024" — consumed first so its year is not read a second time.
  const monthRe = new RegExp(`\\b(${Object.keys(MONTHS).join("|")})\\s+((?:19|20)\\d{2})\\b`, "gu");
  rest = rest.replace(monthRe, (_match, name: string, yearText: string) => {
    const month = MONTHS[name] as number;
    const year = Number(yearText);
    widen(`${year}-${pad2(month)}-01`, `${year}-${pad2(month)}-${pad2(lastDayOfMonth(year, month))}`);
    return " ";
  });

  const thisYear = now.getUTCFullYear();
  const relative: ReadonlyArray<readonly [RegExp, number]> = [
    [/\bvorletzte[sn]?\s+jahr\b/u, thisYear - 2],
    [/\bletzte[sn]?\s+jahr\b/u, thisYear - 1],
    [/\bdiese[sm]?\s+jahr\b/u, thisYear],
  ];
  for (const [pattern, year] of relative) {
    if (pattern.test(rest)) {
      widen(`${year}-01-01`, `${year}-12-31`);
      rest = rest.replace(pattern, " ");
    }
  }

  // "seit 2022" opens the range to today; a bare year is that whole year.
  const sinceRe = /\bseit\s+((?:19|20)\d{2})\b/gu;
  rest = rest.replace(sinceRe, (_match, yearText: string) => {
    widen(`${yearText}-01-01`, null);
    return " ";
  });
  for (const match of rest.matchAll(/(?<![\p{N}])((?:19|20)\d{2})(?![\p{N}])/gu)) {
    const year = Number(match[1]);
    if (year < 1990 || year > 2099) continue;
    widen(`${year}-01-01`, `${year}-12-31`);
  }
  return { from, to };
}

/** Inflections the plain type-name substring misses (umlaut plurals, verb forms). */
const TYPE_ALIASES: ReadonlyArray<readonly [DocumentType, readonly string[]]> = [
  ["Vertrag", ["verträge", "vertraege"]],
  ["Kündigung", ["kündig", "kuendig"]],
];

/** "letzte Gehaltsabrechnung", "neuester Arztbrief" — but not "letztes Jahr", which is a date. */
function asksForNewest(question: string): boolean {
  return /\b(?:letzte[nrsm]?|neueste[nrsm]?|aktuelle[nrsm]?|jüngste[nrsm]?)\b(?!\s+jahr)/u.test(
    question.toLowerCase(),
  );
}

function parseTypes(question: string): DocumentType[] {
  const lowered = question.toLowerCase();
  const out: DocumentType[] = [];
  const seen = new Set<DocumentType>();
  const add = (type: DocumentType): void => {
    if (seen.has(type)) return;
    seen.add(type);
    out.push(type);
  };
  for (const type of docTypesForIntents(detectIntents(question))) add(type);
  for (const type of DOCUMENT_TYPES) {
    if (type === "Sonstiges") continue;
    // Substring: "Rechnungen" contains "rechnung".
    if (lowered.includes(type.toLowerCase())) add(type);
  }
  for (const [type, aliases] of TYPE_ALIASES) {
    if (aliases.some((alias) => lowered.includes(alias))) add(type);
  }
  // A Steuerbescheid is a Bescheid (Finanzamt-issued), not a Steuer filing (CLAUDE.md taxonomy).
  const withoutBescheid = lowered.replace(/steuerbescheid\p{L}*/gu, " ");
  if (lowered !== withoutBescheid) {
    return out.filter(
      (type) =>
        !(
          (type === "Steuer" && !withoutBescheid.includes("steuer")) ||
          (type === "Lohnsteuerbescheinigung" && !withoutBescheid.includes("lohnsteuer"))
        ),
    );
  }
  return out;
}

/** The distinctive tokens of a correspondent name (no legal forms, no generic words, no short bits). */
export function distinctiveTokens(name: string): string[] {
  return words(name).filter(
    (token) =>
      token.length >= MIN_TOKEN_LENGTH && !LEGAL_FORMS.has(token) && !GENERIC_TOKENS.has(token),
  );
}

function tokenInQuestion(token: string, questionWords: readonly string[]): boolean {
  return questionWords.some(
    (word) =>
      word === token ||
      (word.startsWith(token) && word.length - token.length <= MAX_INFLECTION),
  );
}

function parseCorrespondents(question: string, known: readonly string[]): string[] {
  const questionWords = words(question);
  const lowered = question.toLowerCase();
  const scored: { name: string; score: number }[] = [];
  for (const name of known) {
    const tokens = distinctiveTokens(name);
    if (tokens.length === 0) {
      // A name made only of generic words ("Deutsche Bank") matches only as a whole.
      const whole = name.trim().toLowerCase();
      if (whole.length >= MIN_TOKEN_LENGTH && lowered.includes(whole)) {
        scored.push({ name, score: 1 });
      }
      continue;
    }
    const hits = tokens.filter((token) => tokenInQuestion(token, questionWords)).length;
    if (hits > 0) scored.push({ name, score: hits });
  }
  scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  return scored.slice(0, MAX_CORRESPONDENTS).map((entry) => entry.name);
}

function stripStopWords(question: string): string {
  return words(question)
    .filter((word) => !STOP_WORDS.has(word) && word.length > 1)
    .join(" ");
}

export function parseQuestion(
  question: string,
  options: { correspondents: readonly string[]; now: Date },
): ParsedQuestion {
  const dates = parseDates(question, options.now);
  return {
    dateFrom: dates.from,
    dateTo: dates.to,
    docTypes: parseTypes(question),
    correspondents: parseCorrespondents(question, options.correspondents),
    text: stripStopWords(question),
    newest: asksForNewest(question),
  };
}

export function hasHints(parsed: ParsedQuestion): boolean {
  return (
    parsed.dateFrom !== null ||
    parsed.dateTo !== null ||
    parsed.docTypes.length > 0 ||
    parsed.correspondents.length > 0
  );
}

/** German one-liner for `meta.explanation`, e.g. "Erkannt: 2025 · Rechnung · Vattenfall". */
export function explainParsed(parsed: ParsedQuestion): string {
  const parts: string[] = [];
  if (parsed.dateFrom !== null && parsed.dateTo !== null) {
    const wholeYear =
      parsed.dateFrom.endsWith("-01-01") &&
      parsed.dateTo.endsWith("-12-31") &&
      parsed.dateFrom.slice(0, 4) === parsed.dateTo.slice(0, 4);
    parts.push(wholeYear ? parsed.dateFrom.slice(0, 4) : `${parsed.dateFrom} bis ${parsed.dateTo}`);
  } else if (parsed.dateFrom !== null) {
    parts.push(`ab ${parsed.dateFrom.slice(0, 4)}`);
  } else if (parsed.dateTo !== null) {
    parts.push(`bis ${parsed.dateTo}`);
  }
  parts.push(...parsed.docTypes, ...parsed.correspondents);
  return parts.length === 0
    ? "Suche in Inhalt und Volltext."
    : `Erkannt: ${parts.join(" · ")}`;
}
