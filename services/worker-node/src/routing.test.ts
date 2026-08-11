import { describe, expect, it } from "vitest";
import type { DocumentExtraction, DocumentType } from "@aktenraum/core-ts";

import { routeLifecycleTags, type RuleSet } from "./routing.js";
import { buildFailClosedRuleSet, parseRuleSet } from "./auto-approve-config.js";

function extraction(overrides: Partial<DocumentExtraction> = {}): DocumentExtraction {
  return {
    document_type: "Rechnung" as DocumentType,
    correspondent: "ACME",
    ai_title: "t",
    confidence: 0.95,
    confidence_reason: "",
    summary_de: "s",
    reference_numbers: [],
    suggested_tags: [],
    key_dates: { issue: "2026-01-01", due: null, period_start: null, period_end: null },
    ...overrides,
  } as DocumentExtraction;
}

function rules(enabled: boolean, minConfidence = 0.9): RuleSet {
  return parseRuleSet([
    { document_type: "Rechnung", enabled, min_confidence: minConfidence },
  ]);
}

const LOW = 0.6;

describe("routeLifecycleTags", () => {
  it("auto-approves when the type is enabled and confidence clears the bar", () => {
    const r = routeLifecycleTags(extraction(), {
      rules: rules(true),
      lowConfidenceThreshold: LOW,
    });
    expect(r.tags).toEqual(["ai-approved", "ai-auto-approved"]);
    expect(r.reason).toBe("auto_approved");
  });

  it("sends a disabled type to pending", () => {
    const r = routeLifecycleTags(extraction(), {
      rules: rules(false),
      lowConfidenceThreshold: LOW,
    });
    expect(r.tags).toEqual(["ai-pending"]);
    expect(r.reason).toBe("type_disabled");
  });

  it("sends a below-threshold confidence to pending", () => {
    const r = routeLifecycleTags(extraction({ confidence: 0.8 }), {
      rules: rules(true, 0.9),
      lowConfidenceThreshold: LOW,
    });
    expect(r.reason).toBe("confidence_below_min");
    expect(r.tags).toEqual(["ai-pending"]);
  });

  it("adds ai-low-confidence below the low-confidence threshold, whichever gate blocked", () => {
    const r = routeLifecycleTags(extraction({ confidence: 0.4 }), {
      rules: rules(true, 0.9),
      lowConfidenceThreshold: LOW,
    });
    expect(r.tags).toEqual(["ai-pending", "ai-low-confidence"]);
  });

  it("fails CLOSED when the rule store was unreachable at cold start", () => {
    const r = routeLifecycleTags(extraction({ confidence: 1 }), {
      rules: buildFailClosedRuleSet(),
      lowConfidenceThreshold: LOW,
    });
    expect(r.reason).toBe("rules_unreachable_fail_closed");
    expect(r.tags).toEqual(["ai-pending"]);
  });

  it("never auto-approves an untrusted source, even at full confidence on an enabled type", () => {
    const r = routeLifecycleTags(extraction({ confidence: 1 }), {
      rules: rules(true, 0.5),
      lowConfidenceThreshold: LOW,
      untrustedSource: true,
    });
    expect(r.reason).toBe("untrusted_source_no_auto_approve");
    expect(r.tags).toEqual(["ai-pending"]);
  });

  it("treats a type with no rule row as disabled rather than defaulting to approve", () => {
    const r = routeLifecycleTags(extraction({ document_type: "Beleg" as DocumentType }), {
      rules: rules(true),
      lowConfidenceThreshold: LOW,
    });
    expect(r.reason).toBe("type_disabled");
  });

  it("treats confidence exactly at min_confidence as passing", () => {
    const r = routeLifecycleTags(extraction({ confidence: 0.9 }), {
      rules: rules(true, 0.9),
      lowConfidenceThreshold: LOW,
    });
    expect(r.reason).toBe("auto_approved");
  });
});

describe("buildFailClosedRuleSet", () => {
  it("disables every document type", () => {
    const rs = buildFailClosedRuleSet();
    expect(rs.failClosed).toBe(true);
    expect([...rs.byType.values()].every((r) => !r.enabled)).toBe(true);
    expect(rs.byType.size).toBe(27);
  });
});

describe("parseRuleSet", () => {
  it("ignores unknown document types from the wire", () => {
    const rs = parseRuleSet([
      { document_type: "Rechnung", enabled: true, min_confidence: 0.9 },
      { document_type: "NichtEinTyp", enabled: true, min_confidence: 0.1 },
    ]);
    expect(rs.byType.size).toBe(1);
    expect(rs.failClosed).toBe(false);
  });
});
