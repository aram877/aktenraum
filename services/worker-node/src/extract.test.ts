import { describe, expect, it } from "vitest";
import type { DocumentExtraction, DocumentType } from "@aktenraum/core-ts";

import { applyFallbacks, formatError } from "./extract.js";

function extraction(overrides: Partial<DocumentExtraction> = {}): DocumentExtraction {
  return {
    document_type: "Rechnung" as DocumentType,
    correspondent: "Stadtwerke",
    ai_title: "Stromrechnung",
    confidence: 0.92,
    confidence_reason: "Klarer Briefkopf",
    summary_de: "Eine Rechnung.",
    reference_numbers: ["RE-1"],
    suggested_tags: ["Strom"],
    key_dates: { issue: "2026-03-15", due: null, period_start: null, period_end: null },
    ...overrides,
  } as DocumentExtraction;
}

describe("applyFallbacks", () => {
  it("changes nothing when the model filled every field", () => {
    const { extraction: out, applied } = applyFallbacks(extraction(), "irrelevant");
    expect(applied).toEqual([]);
    expect(out).toEqual(extraction());
  });

  it("synthesises ai_title when the model dropped it", () => {
    const { extraction: out, applied } = applyFallbacks(extraction({ ai_title: "" }), "");
    expect(applied).toContain("ai_title");
    expect(out.ai_title).not.toBe("");
  });

  it("treats a whitespace-only field as dropped", () => {
    const { applied } = applyFallbacks(extraction({ summary_de: "   " }), "");
    expect(applied).toContain("summary_de");
  });

  it("synthesises a confidence_reason appropriate to the score", () => {
    const { extraction: out, applied } = applyFallbacks(
      extraction({ confidence_reason: "" }),
      "",
    );
    expect(applied).toContain("confidence_reason");
    expect((out.confidence_reason ?? "").length).toBeGreaterThan(0);
  });

  it("harvests reference numbers from the FULL content, not the truncated prompt text", () => {
    const { extraction: out, applied } = applyFallbacks(
      extraction({ reference_numbers: [] }),
      "…viele Seiten… Aktenzeichen: AZ-4711 …",
    );
    expect(applied).toContain("reference_numbers");
    expect(out.reference_numbers).toEqual(["AZ-4711"]);
  });

  it("does not claim a reference_numbers fallback when the text has none", () => {
    const { applied } = applyFallbacks(
      extraction({ reference_numbers: [] }),
      "keine kennzeichnung hier",
    );
    expect(applied).not.toContain("reference_numbers");
  });

  it("never overrides a value the model did emit", () => {
    const { extraction: out } = applyFallbacks(
      extraction({ suggested_tags: ["NurDieser"] }),
      "Aktenzeichen: AZ-1",
    );
    expect(out.suggested_tags).toEqual(["NurDieser"]);
    expect(out.reference_numbers).toEqual(["RE-1"]);
  });

  it("fills every droppable field at once when the model returned a bare skeleton", () => {
    const { applied } = applyFallbacks(
      extraction({
        ai_title: "",
        confidence_reason: "",
        summary_de: "",
        suggested_tags: [],
        reference_numbers: [],
      }),
      "Aktenzeichen: AZ-9",
    );
    expect(applied.sort()).toEqual(
      ["ai_title", "confidence_reason", "reference_numbers", "suggested_tags", "summary_de"].sort(),
    );
  });
});

describe("formatError", () => {
  it("labels the failure and names the error type", () => {
    expect(formatError("LLM-Extraktion fehlgeschlagen", new TypeError("boom"))).toBe(
      "LLM-Extraktion fehlgeschlagen – TypeError: boom",
    );
  });

  it("handles a non-Error throw without crashing", () => {
    expect(formatError("X", "plain string")).toContain("plain string");
  });
});
