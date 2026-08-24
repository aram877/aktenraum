import { describe, expect, it } from "vitest";
import {
  DOCUMENT_TYPES,
  DocumentExtractionSchema,
  DocumentTypeSchema,
} from "./extraction.js";
import { AutoApproveRuleSchema } from "./autoApprove.js";

// Mirrors services/auto-tagger/tests/test_models.py.

describe("DocumentType", () => {
  it("has 27 canonical values", () => {
    // The taxonomy is documented in CLAUDE.md; if this changes, update both.
    expect(DOCUMENT_TYPES.length).toBe(27);
  });

  it("round-trips known values", () => {
    for (const v of ["Rechnung", "Vertrag", "Kontoauszug", "Sonstiges", "Bescheid"]) {
      expect(DocumentTypeSchema.parse(v)).toBe(v);
    }
  });
});

describe("DocumentExtraction validation", () => {
  function base(overrides: Record<string, unknown> = {}) {
    return {
      document_type: "Rechnung",
      correspondent: "X",
      key_dates: { issue: null },
      summary_de: "Satz eins. Satz zwei. Satz drei.",
      confidence: 0.9,
      ...overrides,
    };
  }

  it("accepts a minimal valid construction", () => {
    expect(() => DocumentExtractionSchema.parse(base())).not.toThrow();
  });

  it("rejects an unknown document type", () => {
    expect(() => DocumentExtractionSchema.parse(base({ document_type: "NotAType" }))).toThrow();
  });

  it("rejects confidence above one", () => {
    expect(() => DocumentExtractionSchema.parse(base({ confidence: 1.5 }))).toThrow();
  });

  it("rejects confidence below zero", () => {
    expect(() => DocumentExtractionSchema.parse(base({ confidence: -0.1 }))).toThrow();
  });

  it("accepts confidence at the boundaries", () => {
    expect(() => DocumentExtractionSchema.parse(base({ confidence: 0.0 }))).not.toThrow();
    expect(() => DocumentExtractionSchema.parse(base({ confidence: 1.0 }))).not.toThrow();
  });

  it("coerces ints to strings in reference_numbers", () => {
    // Real-world: small local models occasionally emit integers in
    // list-of-string fields; the coercion preprocessor tolerates that.
    const ex = DocumentExtractionSchema.parse(base({ reference_numbers: [42, "INV-1"] }));
    expect(ex.reference_numbers).toEqual(["42", "INV-1"]);
  });

  it("coerces ints to strings in suggested_tags", () => {
    const ex = DocumentExtractionSchema.parse(base({ suggested_tags: [1, 2, "Vertrag"] }));
    expect(ex.suggested_tags).toEqual(["1", "2", "Vertrag"]);
  });

  it("coerces null to an empty list for reference_numbers", () => {
    // Local models often emit null for empty array fields despite the
    // schema. Coerce null -> [] so a representation choice doesn't fail the
    // whole extraction.
    const ex = DocumentExtractionSchema.parse(base({ reference_numbers: null }));
    expect(ex.reference_numbers).toEqual([]);
  });

  it("coerces null to an empty list for suggested_tags", () => {
    const ex = DocumentExtractionSchema.parse(base({ suggested_tags: null }));
    expect(ex.suggested_tags).toEqual([]);
  });

  it("defaults optional fields correctly", () => {
    const ex = DocumentExtractionSchema.parse(base());
    expect(ex.ai_title).toBeNull();
    expect(ex.reference_numbers).toEqual([]);
    expect(ex.suggested_tags).toEqual([]);
    expect(ex.key_dates.issue).toBeNull();
  });
});

describe("AutoApproveRule", () => {
  it("has correct defaults", () => {
    const rule = AutoApproveRuleSchema.parse({ document_type: "Rechnung" });
    expect(rule.enabled).toBe(false);
    expect(rule.min_confidence).toBe(0.9);
    expect(rule.updated_at).toBeNull();
    expect(rule.updated_by).toBeNull();
  });

  it("accepts min_confidence at zero", () => {
    const rule = AutoApproveRuleSchema.parse({ document_type: "Rechnung", min_confidence: 0.0 });
    expect(rule.min_confidence).toBe(0.0);
  });

  it("accepts min_confidence at one", () => {
    const rule = AutoApproveRuleSchema.parse({ document_type: "Rechnung", min_confidence: 1.0 });
    expect(rule.min_confidence).toBe(1.0);
  });

  it("rejects min_confidence below zero", () => {
    expect(() =>
      AutoApproveRuleSchema.parse({ document_type: "Rechnung", min_confidence: -0.01 }),
    ).toThrow();
  });

  it("rejects min_confidence above one", () => {
    expect(() =>
      AutoApproveRuleSchema.parse({ document_type: "Rechnung", min_confidence: 1.01 }),
    ).toThrow();
  });

  it("rejects an unknown document type", () => {
    expect(() => AutoApproveRuleSchema.parse({ document_type: "NotARealType" })).toThrow();
  });
});
