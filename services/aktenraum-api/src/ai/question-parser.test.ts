import { describe, expect, it } from "vitest";

import { distinctiveTokens, explainParsed, hasHints, parseQuestion } from "./question-parser.js";

const NOW = new Date("2026-11-23T12:00:00Z");
const KNOWN = [
  "Vattenfall Europe Sales GmbH",
  "Stadtwerke München",
  "Stadt Köln",
  "Deutsche Bank",
  "Amazon EU S.à r.l.",
  "Allianz Versicherungs-AG",
  "Techniker Krankenkasse",
];

function parse(question: string) {
  return parseQuestion(question, { correspondents: KNOWN, now: NOW });
}

describe("parseQuestion dates", () => {
  it("reads a year as the whole year", () => {
    const p = parse("Wie viel Strom habe ich 2025 bezahlt?");
    expect(p).toMatchObject({ dateFrom: "2025-01-01", dateTo: "2025-12-31" });
  });

  it("reads relative years against `now`", () => {
    expect(parse("Rechnungen letztes Jahr")).toMatchObject({ dateFrom: "2025-01-01", dateTo: "2025-12-31" });
    expect(parse("Rechnungen vorletztes Jahr")).toMatchObject({ dateFrom: "2024-01-01", dateTo: "2024-12-31" });
    expect(parse("Was habe ich dieses Jahr bezahlt")).toMatchObject({ dateFrom: "2026-01-01", dateTo: "2026-12-31" });
  });

  it("reads a month with a year", () => {
    expect(parse("Gehaltsabrechnung März 2024")).toMatchObject({ dateFrom: "2024-03-01", dateTo: "2024-03-31" });
    expect(parse("Rechnung Februar 2024")).toMatchObject({ dateFrom: "2024-02-01", dateTo: "2024-02-29" });
  });

  it("opens the range for 'seit'", () => {
    expect(parse("Alles seit 2022")).toMatchObject({ dateFrom: "2022-01-01", dateTo: null });
  });

  it("spans several years", () => {
    expect(parse("Strom 2023 und 2025")).toMatchObject({ dateFrom: "2023-01-01", dateTo: "2025-12-31" });
  });

  it("ignores numbers that are not years", () => {
    const p = parse("Rechnung Nr. 1234567 über 12500 Euro");
    expect(p.dateFrom).toBeNull();
    expect(p.dateTo).toBeNull();
  });

  it("has no date for a question without one", () => {
    expect(parse("Wie lange war ich bei der Firma?")).toMatchObject({ dateFrom: null, dateTo: null });
  });
});

describe("parseQuestion types", () => {
  it("uses the intent keywords", () => {
    expect(parse("Was habe ich verdient?").docTypes).toEqual(["Gehaltsabrechnung"]);
  });

  it("matches type names and plurals", () => {
    expect(parse("Welche Mahnungen gibt es?").docTypes).toContain("Mahnung");
    expect(parse("Zeig meine Arztbriefe").docTypes).toContain("Arztbrief");
  });

  it("never returns Sonstiges and de-duplicates", () => {
    const types = parse("Rechnung Rechnungen bezahlt sonstiges").docTypes;
    expect(types).not.toContain("Sonstiges");
    expect(new Set(types).size).toBe(types.length);
  });
});

describe("parseQuestion correspondents", () => {
  it("finds a known correspondent by a distinctive token", () => {
    expect(parse("Was habe ich Vattenfall bezahlt?").correspondents).toEqual(["Vattenfall Europe Sales GmbH"]);
  });

  it("tolerates a short inflection", () => {
    expect(parse("Amazons Rechnungen").correspondents).toEqual(["Amazon EU S.à r.l."]);
  });

  it("does not match a generic word on its own", () => {
    expect(parse("In welcher Stadt wohne ich?").correspondents).toEqual([]);
    expect(parse("Welche Bank hat mir geschrieben?").correspondents).toEqual([]);
    expect(parse("Welche Versicherung ist günstig?").correspondents).toEqual([]);
  });

  it("matches a name made only of generic words as a whole", () => {
    expect(parse("Post von der Deutsche Bank").correspondents).toEqual(["Deutsche Bank"]);
  });

  it("ignores legal forms and short tokens", () => {
    expect(distinctiveTokens("Vattenfall Europe Sales GmbH")).toEqual(["vattenfall", "sales"]);
    expect(parse("Habe ich eine GmbH?").correspondents).toEqual([]);
  });

  it("caps at three matches", () => {
    const many = ["Alpha Strom", "Alpha Gas", "Alpha Wasser", "Alpha Wärme", "Alpha Netz"];
    const p = parseQuestion("Alpha", { correspondents: many, now: NOW });
    expect(p.correspondents).toHaveLength(3);
  });
});

describe("parseQuestion text and hints", () => {
  it("strips stop words for the full-text query", () => {
    expect(parse("Wie lange war ich bei der Firma Muster beschäftigt?").text).toBe("firma muster beschäftigt");
  });

  it("reports no hints for a bare question", () => {
    expect(hasHints(parse("Wie lange war ich bei der Firma?"))).toBe(false);
  });

  it("reports hints when any are present", () => {
    expect(hasHints(parse("Strom 2025"))).toBe(true);
  });
});

describe("explainParsed", () => {
  it("lists year, types and correspondents", () => {
    expect(explainParsed(parse("Wie viel Strom habe ich Vattenfall 2025 für die Rechnung bezahlt?"))).toBe(
      "Erkannt: 2025 · Rechnung · Mahnung · Vattenfall Europe Sales GmbH",
    );
  });

  it("describes ranges and open ranges", () => {
    expect(explainParsed(parse("Gehaltsabrechnung März 2024"))).toContain("2024-03-01 bis 2024-03-31");
    expect(explainParsed(parse("Alles seit 2022"))).toBe("Erkannt: ab 2022");
  });

  it("falls back when nothing was recognised", () => {
    expect(explainParsed(parse("Wie lange war ich bei der Firma?"))).toBe("Suche in Inhalt und Volltext.");
  });
});

describe("parseQuestion regressions (fast-ask live comparison)", () => {
  it("reads umlaut plurals and verb forms of Vertrag / Kündigung", () => {
    expect(parse("Welche Verträge habe ich gekündigt?").docTypes).toEqual(
      expect.arrayContaining(["Vertrag", "Kündigung"]),
    );
  });

  it("treats a Steuerbescheid as a Bescheid, not a Steuer filing", () => {
    const types = parse("Welche Steuerbescheide habe ich bekommen?").docTypes;
    expect(types).toContain("Bescheid");
    expect(types).not.toContain("Steuer");
    expect(types).not.toContain("Lohnsteuerbescheinigung");
  });

  it("keeps Steuer when the question also names it on its own", () => {
    expect(parse("Steuerbescheid und Steuererklärung").docTypes).toContain("Steuer");
  });

  it("flags questions about the newest document, but not 'letztes Jahr'", () => {
    expect(parse("Wann war mein letzter Arztbrief?").newest).toBe(true);
    expect(parse("Was war meine letzte Gehaltsabrechnung?").newest).toBe(true);
    expect(parse("Meine aktuelle Miete").newest).toBe(true);
    expect(parse("Rechnungen letztes Jahr").newest).toBe(false);
    expect(parse("Wie viel Strom 2025?").newest).toBe(false);
  });
});
