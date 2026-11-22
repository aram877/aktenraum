import { describe, expect, it } from "vitest";

import { ALL_DOC_TYPES, FAMILIES, docTypeStyle, familyByKey, familyOfType } from "~/utils/doc-types";

// Mirror of DOCUMENT_TYPES in @aktenraum/core (the web package does not depend on core).
const CORE_TYPES = [
  "Rechnung", "Gehaltsabrechnung", "Kontoauszug", "Nebenkostenabrechnung", "Hausgeldabrechnung", "Mahnung",
  "Vertrag", "Kündigung", "Versicherung", "Steuer", "Lohnsteuerbescheinigung", "Spendenbescheinigung", "Bescheid",
  "Behördenbrief", "Sozialversicherungsmeldung", "Kfz", "Bußgeldbescheid", "Arztbrief", "Krankschreibung",
  "Garantie", "Urkunde", "Ausweis", "Zeugnis", "Arbeitszeugnis", "Mitgliedschaft", "Beleg", "Sonstiges",
];

function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("doc-types", () => {
  it("covers exactly the 27 core document types, each in one area", () => {
    expect([...ALL_DOC_TYPES].sort()).toEqual([...CORE_TYPES].sort());
    expect(new Set(ALL_DOC_TYPES).size).toBe(27);
    expect(FAMILIES).toHaveLength(9);
  });

  it("gives every type a unique 2-letter code", () => {
    const codes = ALL_DOC_TYPES.map((t) => docTypeStyle(t).code);
    expect(new Set(codes).size).toBe(27);
    for (const code of codes) expect(code).toHaveLength(2);
  });

  it("maps types to their area", () => {
    expect(docTypeStyle("Bußgeldbescheid")).toMatchObject({ code: "BG", family: { key: "mobil" } });
    expect(familyOfType("Arztbrief").key).toBe("gesund");
    expect(docTypeStyle("rechnung").name).toBe("Rechnung");
  });

  it("treats missing and unknown types as Sonstiges, keeping the name", () => {
    expect(docTypeStyle(null)).toMatchObject({ name: "Sonstiges", code: "SO", family: { key: "sonst" } });
    expect(docTypeStyle("  ")).toMatchObject({ code: "SO" });
    expect(docTypeStyle("Quittung")).toMatchObject({ name: "Quittung", code: "SO", family: { key: "sonst" } });
  });

  it("looks up areas by key", () => {
    expect(familyByKey("wohnen")?.types).toEqual(["Nebenkostenabrechnung", "Hausgeldabrechnung"]);
    expect(familyByKey("nope")).toBeNull();
  });

  it("keeps the area colours readable", () => {
    for (const f of FAMILIES) {
      expect(contrast("#ffffff", f.fill), `${f.name} fill`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(f.ink, f.tint), `${f.name} ink on tint`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
