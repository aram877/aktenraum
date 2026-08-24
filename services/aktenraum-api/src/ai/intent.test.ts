import { describe, expect, it } from "vitest";

import { INTENTS, INTENT_DOC_TYPES, detectIntents, docTypesForIntents } from "./intent.js";
import type { Intent } from "./intent.js";

function intents(question: string): Intent[] {
  return [...detectIntents(question)].sort();
}

describe("detectIntents", () => {
  it("detects salary", () => {
    expect(intents("Wie viel habe ich letztes Jahr verdient?")).toEqual(["salary"]);
  });

  it("detects spending", () => {
    expect(intents("Was hat die Reparatur gekostet?")).toEqual(["spending"]);
  });

  it("detects tax", () => {
    expect(intents("Wann kommt die Erstattung vom Finanzamt?")).toEqual(["tax"]);
  });

  it("detects insurance", () => {
    expect(intents("Wie hoch ist meine Prämie?")).toEqual(["insurance"]);
  });

  it("detects housing", () => {
    expect(intents("Wie hoch war die Miete?")).toEqual(["housing"]);
  });

  it("detects medical", () => {
    expect(intents("Wann war ich beim Arzt?")).toEqual(["medical"]);
  });

  it("detects medical via the hyphenated keyword", () => {
    expect(intents("Brauche ich eine AU-Bescheinigung?")).toEqual(["medical"]);
  });

  it("detects id_document", () => {
    expect(intents("Wann läuft mein Reisepass ab?")).toEqual(["id_document"]);
  });

  it("detects car", () => {
    expect(intents("Wann ist der TÜV fällig?")).toEqual(["car"]);
  });

  it("detects contract", () => {
    expect(intents("Ich möchte meinen Vertrag beenden")).toEqual(["contract"]);
  });

  it("matches German compounds by substring", () => {
    expect(intents("Wo ist meine Steuererklärung?")).toEqual(["tax"]);
    expect(intents("Ich suche meinen Gehaltszettel")).toEqual(["salary"]);
  });

  it("is case-insensitive", () => {
    expect(intents("FINANZAMT")).toEqual(["tax"]);
    expect(intents("finanzamt")).toEqual(["tax"]);
  });

  it("matches the strict keyword 'pass' as a whole word", () => {
    expect(intents("Ist mein Pass noch da?")).toEqual(["id_document"]);
  });

  it("does not match the strict keyword 'pass' inside a longer word", () => {
    expect(intents("Wie lautet mein Passwort?")).toEqual([]);
  });

  it("does not match the strict keyword 'pass' before a non-ASCII letter", () => {
    expect(intents("Passüberprüfung")).toEqual([]);
  });

  it("still detects id_document for Reisepass via its own keyword", () => {
    expect(intents("Reisepass")).toEqual(["id_document"]);
  });

  it("matches the strict keyword 'lohn' as a whole word", () => {
    expect(intents("Wie hoch ist mein Lohn?")).toEqual(["salary"]);
  });

  it("does not match the strict keyword 'lohn' inside a longer word", () => {
    expect(intents("Das würde sich nicht lohnen")).toEqual([]);
  });

  it("does not match the strict keyword 'lohn' before an umlaut", () => {
    expect(intents("Lohnübersicht")).toEqual([]);
  });

  it("returns nothing for a neutral question", () => {
    expect(intents("Wo ist mein Regenschirm?")).toEqual([]);
  });

  it("returns nothing for an empty question", () => {
    expect(intents("")).toEqual([]);
  });

  it("fires multiple intents", () => {
    expect(intents("Ich brauche die Gehaltsabrechnung für meine Steuererklärung")).toEqual([
      "salary",
      "spending",
      "tax",
    ]);
  });

  it("fires spending alongside housing for Nebenkosten", () => {
    expect(intents("Wie hoch waren die Nebenkosten und was habe ich bezahlt?")).toEqual([
      "housing",
      "spending",
    ]);
  });
});

describe("docTypesForIntents", () => {
  it("returns an empty list for no intents", () => {
    expect(docTypesForIntents(new Set())).toEqual([]);
  });

  it("maps a single intent", () => {
    expect(docTypesForIntents(new Set<Intent>(["salary"]))).toEqual(["Gehaltsabrechnung"]);
  });

  it("preserves the intent declaration order regardless of set order", () => {
    expect(docTypesForIntents(new Set<Intent>(["contract", "spending"]))).toEqual([
      "Rechnung",
      "Mahnung",
      "Vertrag",
      "Kündigung",
    ]);
  });

  it("flattens every intent in declaration order", () => {
    expect(docTypesForIntents(new Set<Intent>(INTENTS))).toEqual([
      "Gehaltsabrechnung",
      "Rechnung",
      "Mahnung",
      "Steuer",
      "Lohnsteuerbescheinigung",
      "Versicherung",
      "Nebenkostenabrechnung",
      "Hausgeldabrechnung",
      "Arztbrief",
      "Krankschreibung",
      "Ausweis",
      "Kfz",
      "Vertrag",
      "Kündigung",
    ]);
  });

  it("returns no duplicates", () => {
    const all = docTypesForIntents(new Set<Intent>(INTENTS));
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("INTENT_DOC_TYPES", () => {
  it("covers every intent", () => {
    for (const intent of INTENTS) {
      expect(INTENT_DOC_TYPES[intent].length).toBeGreaterThan(0);
    }
  });
});
