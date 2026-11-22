// Document type system (ui-redesign-foundation): the 27 document types sorted
// into 9 areas. The area gives the colour ("where in life"), the icon and the
// 2-letter code say "what exactly". Unknown or missing types are Sonstiges.
//
// Contrast (checked when the palette was chosen): white text on every `fill`
// is >= 4.8:1, every `ink` on its `tint` is >= 4.5:1.

export type FamilyKey = "geld" | "arbeit" | "amt" | "wohnen" | "vertrag" | "gesund" | "mobil" | "person" | "sonst";

export interface DocFamily {
  key: FamilyKey;
  name: string;
  /** Tile background; white text on it. */
  fill: string;
  /** Light background for headers and selected chips. */
  tint: string;
  /** Text colour on `tint` and the type name in lists. */
  ink: string;
  types: readonly string[];
}

export interface DocTypeStyle {
  name: string;
  code: string;
  /** SVG path data for a 24×24 stroke icon. */
  icon: string;
  family: DocFamily;
}

const ICONS = {
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6M9 16h4",
  alert: "M12 3l9.5 17h-19L12 3zM12 10v4M12 17.5v.01",
  bank: "M3 9l9-5 9 5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18",
  ticket: "M4 7h16v3a2 2 0 000 4v3H4v-3a2 2 0 000-4V7zM14 7v10",
  banknote: "M3 7h18v10H3zM12 9.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM6 10v.01M18 14v.01",
  taxdoc: "M7 3h7l4 4v14H7zM14 3v4h4M10 16l5-5M10.5 11.5v.01M14.5 15.5v.01",
  award: "M12 3a5 5 0 100 10 5 5 0 000-10zM8.5 12L7 21l5-3 5 3-1.5-9",
  shield: "M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6l8-3zM9 12l2 2 4-4",
  percent: "M19 5L5 19M7 5a2 2 0 100 4 2 2 0 000-4zM17 15a2 2 0 100 4 2 2 0 000-4z",
  stamp: "M9 3h6v5l-1 3h4v4H6v-4h4L9 8V3zM5 19h14v2H5z",
  columns: "M3 21h18M5 21V11M9 21V11M15 21V11M19 21V11M2 10l10-6 10 6H2z",
  heart: "M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z",
  flame: "M12 3c1 3 5 5 5 10a5 5 0 01-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3-1-5 1-8.5z",
  house: "M3 11l9-7 9 7M5 10v10h14V10M10 20v-6h4v6",
  pen: "M4 20h7M14.5 4.5l5 5L9 20H4v-5L14.5 4.5z",
  exit: "M14 4h5v16h-5M3 12h11M10 8l4 4-4 4",
  umbrella: "M3 12a9 9 0 0118 0H3zM12 12v6a2 2 0 004 0M12 3v1",
  people: "M9 11a3 3 0 100-6 3 3 0 000 6zM3 20c0-3 2.7-5 6-5s6 2 6 5M16 5a3 3 0 010 6M21 20c0-2.5-1.5-4.2-4-4.8",
  badge:
    "M12 3l2.4 1.8 3-.2.8 2.9 2.4 1.8-1 2.7 1 2.7-2.4 1.8-.8 2.9-3-.2L12 21l-2.4-1.8-3 .2-.8-2.9-2.4-1.8 1-2.7-1-2.7 2.4-1.8.8-2.9 3 .2L12 3zM9 12l2 2 4-4",
  steth: "M6 3v6a4 4 0 008 0V3M10 13v3a4 4 0 008 0v-2M18 14a2 2 0 100-4 2 2 0 000 4z",
  thermo: "M10 4a2 2 0 014 0v10a4 4 0 11-4 0V4zM12 9v7",
  car: "M3 16v-4l2-5h14l2 5v4H3zM4 12h16M7 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM17 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3z",
  gauge: "M4 17a8 8 0 1116 0M12 17l4-5M12 17v.01",
  scroll: "M6 4h11a2 2 0 012 2v12a2 2 0 01-2 2H8a2 2 0 01-2-2V4zM6 4a2 2 0 00-2 2v2h2M10 9h6M10 13h6",
  idcard: "M3 6h18v12H3zM9 11a2 2 0 100-4 2 2 0 000 4zM6 15c.5-1.5 1.7-2 3-2s2.5.5 3 2M14 9h4M14 13h4",
  cap: "M2 9l10-5 10 5-10 5L2 9zM6 11v5c3 2 9 2 12 0v-5M22 9v5",
  file: "M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5",
} as const;

type IconKey = keyof typeof ICONS;

interface FamilySpec {
  key: FamilyKey;
  name: string;
  fill: string;
  tint: string;
  ink: string;
  types: readonly (readonly [name: string, code: string, icon: IconKey])[];
}

const SPEC: readonly FamilySpec[] = [
  {
    key: "geld",
    name: "Geld",
    fill: "#9a6408",
    tint: "#f4e8cc",
    ink: "#6b4504",
    types: [
      ["Rechnung", "RE", "receipt"],
      ["Mahnung", "MA", "alert"],
      ["Kontoauszug", "KA", "bank"],
      ["Beleg", "BE", "ticket"],
    ],
  },
  {
    key: "arbeit",
    name: "Arbeit",
    fill: "#3f3f9a",
    tint: "#e4e4f4",
    ink: "#2e2e78",
    types: [
      ["Gehaltsabrechnung", "GA", "banknote"],
      ["Lohnsteuerbescheinigung", "LS", "taxdoc"],
      ["Arbeitszeugnis", "AZ", "award"],
      ["Sozialversicherungsmeldung", "SV", "shield"],
    ],
  },
  {
    key: "amt",
    name: "Amt & Steuer",
    fill: "#2f4a66",
    tint: "#dfe6ee",
    ink: "#22374d",
    types: [
      ["Steuer", "ST", "percent"],
      ["Bescheid", "BS", "stamp"],
      ["Behördenbrief", "BB", "columns"],
      ["Spendenbescheinigung", "SP", "heart"],
    ],
  },
  {
    key: "wohnen",
    name: "Wohnen",
    fill: "#a1442a",
    tint: "#f4e0d8",
    ink: "#7a301c",
    types: [
      ["Nebenkostenabrechnung", "NK", "flame"],
      ["Hausgeldabrechnung", "HG", "house"],
    ],
  },
  {
    key: "vertrag",
    name: "Verträge",
    fill: "#6d3a6b",
    tint: "#eee0ed",
    ink: "#532a51",
    types: [
      ["Vertrag", "VT", "pen"],
      ["Kündigung", "KÜ", "exit"],
      ["Versicherung", "VS", "umbrella"],
      ["Mitgliedschaft", "MG", "people"],
      ["Garantie", "GT", "badge"],
    ],
  },
  {
    key: "gesund",
    name: "Gesundheit",
    fill: "#1f6b5c",
    tint: "#d9ece7",
    ink: "#155246",
    types: [
      ["Arztbrief", "AB", "steth"],
      ["Krankschreibung", "KS", "thermo"],
    ],
  },
  {
    key: "mobil",
    name: "Mobilität",
    fill: "#9f1d3f",
    tint: "#f4dbe1",
    ink: "#7a142f",
    types: [
      ["Kfz", "KF", "car"],
      ["Bußgeldbescheid", "BG", "gauge"],
    ],
  },
  {
    key: "person",
    name: "Persönlich",
    fill: "#5f6326",
    tint: "#e8e9d4",
    ink: "#46491a",
    types: [
      ["Urkunde", "UR", "scroll"],
      ["Ausweis", "AW", "idcard"],
      ["Zeugnis", "ZG", "cap"],
    ],
  },
  {
    key: "sonst",
    name: "Sonstiges",
    fill: "#78716c",
    tint: "#ece9e5",
    ink: "#57534e",
    types: [["Sonstiges", "SO", "file"]],
  },
];

export const FAMILIES: readonly DocFamily[] = SPEC.map((f) => ({
  key: f.key,
  name: f.name,
  fill: f.fill,
  tint: f.tint,
  ink: f.ink,
  types: f.types.map(([name]) => name),
}));

const STYLES = new Map<string, DocTypeStyle>();
for (const [index, spec] of SPEC.entries()) {
  const family = FAMILIES[index]!;
  for (const [name, code, icon] of spec.types) {
    STYLES.set(name.toLowerCase(), { name, code, icon: ICONS[icon], family });
  }
}

const OTHER = STYLES.get("sonstiges")!;

/** Style of a document type; null, empty and unknown names become Sonstiges (keeping the given name). */
export function docTypeStyle(name: string | null | undefined): DocTypeStyle {
  const trimmed = (name ?? "").trim();
  if (trimmed === "") return OTHER;
  const known = STYLES.get(trimmed.toLowerCase());
  return known ?? { ...OTHER, name: trimmed };
}

export function familyByKey(key: string | null | undefined): DocFamily | null {
  return FAMILIES.find((f) => f.key === key) ?? null;
}

/** The family a type belongs to (Sonstiges for unknown types). */
export function familyOfType(name: string | null | undefined): DocFamily {
  return docTypeStyle(name).family;
}

/** All 27 known type names, in area order. */
export const ALL_DOC_TYPES: readonly string[] = FAMILIES.flatMap((f) => f.types);
