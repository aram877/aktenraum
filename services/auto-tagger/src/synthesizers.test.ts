import { describe, expect, it } from "vitest";
import type { DocumentExtraction, DocumentType } from "@aktenraum/core";

import {
  extractReferenceNumbersFromText,
  formatIssueDateDe,
  synthesizeSuggestedTags,
  synthesizeSummaryDe,
} from "./synthesizers.js";

function extraction(overrides: Partial<DocumentExtraction> = {}): DocumentExtraction {
  return {
    document_type: "Rechnung" as DocumentType,
    correspondent: "Stadtwerke",
    ai_title: "Stromrechnung",
    confidence: 0.9,
    confidence_reason: "",
    summary_de: "",
    reference_numbers: [],
    suggested_tags: [],
    key_dates: { issue: "2026-03-15", due: null, period_start: null, period_end: null },
    ...overrides,
  } as DocumentExtraction;
}

describe("formatIssueDateDe", () => {
  it("renders a German month and year", () => {
    expect(formatIssueDateDe("2026-03-15")).toBe("März 2026");
  });

  it("returns null for junk rather than leaking 'Invalid Date'", () => {
    expect(formatIssueDateDe("irgendwann")).toBeNull();
    expect(formatIssueDateDe(null)).toBeNull();
    expect(formatIssueDateDe("")).toBeNull();
  });
});

describe("synthesizeSummaryDe", () => {
  it("builds type + sender + date as the identification line", () => {
    expect(synthesizeSummaryDe(extraction())).toContain(
      "Rechnung von Stadtwerke vom März 2026.",
    );
  });

  it("is never empty even with only a document type", () => {
    const out = synthesizeSummaryDe(
      extraction({ correspondent: null, ai_title: "", key_dates: { issue: null } as never }),
    );
    expect(out).toBe("Rechnung.");
  });

  it("adds the title only when it is not already in the first sentence", () => {
    expect(synthesizeSummaryDe(extraction())).toContain("Betreff: Stromrechnung.");
    const dup = synthesizeSummaryDe(extraction({ ai_title: "Stadtwerke" }));
    expect(dup).not.toContain("Betreff:");
  });

  it("prefers reference numbers over tags for the third sentence", () => {
    const withRefs = synthesizeSummaryDe(
      extraction({ reference_numbers: ["A-1"], suggested_tags: ["Strom"] }),
    );
    expect(withRefs).toContain("Aktenzeichen: A-1.");
    expect(withRefs).not.toContain("Themen:");
  });

  it("falls back to tags when there are no reference numbers", () => {
    expect(synthesizeSummaryDe(extraction({ suggested_tags: ["Strom"] }))).toContain(
      "Themen: Strom.",
    );
  });
});

describe("synthesizeSuggestedTags", () => {
  it("returns the doc type plus the issue year", () => {
    expect(synthesizeSuggestedTags(extraction())).toEqual(["Rechnung", "2026"]);
  });

  it("omits the year when the issue date is missing", () => {
    expect(
      synthesizeSuggestedTags(extraction({ key_dates: { issue: null } as never })),
    ).toEqual(["Rechnung"]);
  });
});

describe("extractReferenceNumbersFromText", () => {
  it("harvests a labelled Aktenzeichen", () => {
    expect(extractReferenceNumbersFromText("Aktenzeichen: AB-1234/5")).toEqual(["AB-1234/5"]);
  });

  it("matches the label case-insensitively but preserves the value's case", () => {
    expect(extractReferenceNumbersFromText("rechnungsnummer: RE-2026-A")).toEqual([
      "RE-2026-A",
    ]);
  });

  it("dedupes case-insensitively", () => {
    const out = extractReferenceNumbersFromText("Az: X-9 und Aktenzeichen: x-9");
    expect(out).toEqual(["x-9"]);
  });

  it("returns nothing for unlabelled numbers, so dates and IBANs are not harvested", () => {
    expect(extractReferenceNumbersFromText("Am 15.03.2026 DE89 3704 0044 0532 0130 00")).toEqual(
      [],
    );
  });

  it("honours the limit", () => {
    const text = "Aktenzeichen: AZ-100 Rechnungsnr: RE-200 Vertragsnr: VE-300 Kundennr: KD-400";
    expect(extractReferenceNumbersFromText(text, 2)).toHaveLength(2);
  });

  it("ignores values shorter than 3 characters — the guard against harvesting noise", () => {
    expect(extractReferenceNumbersFromText("Aktenzeichen: A1")).toEqual([]);
    expect(extractReferenceNumbersFromText("Aktenzeichen: A12")).toEqual(["A12"]);
  });

  it("returns nothing for empty text", () => {
    expect(extractReferenceNumbersFromText("")).toEqual([]);
  });
});
