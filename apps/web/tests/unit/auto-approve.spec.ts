import { describe, expect, it } from "vitest";

import {
  buildDraft,
  formatTimestamp,
  isDraftDirty,
  type AutoApproveRule,
  type DraftEntry,
} from "~/utils/settings";

function rule(overrides: Partial<AutoApproveRule> = {}): AutoApproveRule {
  return {
    document_type: "Rechnung",
    enabled: false,
    min_confidence: 0.9,
    updated_at: null,
    updated_by: null,
    ...overrides,
  };
}

describe("buildDraft", () => {
  it("mirrors the server rules", () => {
    const draft = buildDraft([rule(), rule({ document_type: "Beleg", enabled: true })]);
    expect(draft.get("Rechnung")).toEqual({ enabled: false, min_confidence: 0.9 });
    expect(draft.get("Beleg")).toEqual({ enabled: true, min_confidence: 0.9 });
  });
});

describe("isDraftDirty", () => {
  const rules = [rule(), rule({ document_type: "Beleg" })];

  it("is false for an untouched draft", () => {
    expect(isDraftDirty(rules, buildDraft(rules))).toBe(false);
  });

  it("detects a toggled checkbox", () => {
    const draft = buildDraft(rules);
    draft.set("Beleg", { enabled: true, min_confidence: 0.9 });
    expect(isDraftDirty(rules, draft)).toBe(true);
  });

  it("detects a changed threshold", () => {
    const draft = buildDraft(rules);
    draft.set("Rechnung", { enabled: false, min_confidence: 0.95 });
    expect(isDraftDirty(rules, draft)).toBe(true);
  });

  it("treats a missing entry as dirty rather than silently clean", () => {
    const draft = new Map<string, DraftEntry>();
    expect(isDraftDirty(rules, draft)).toBe(true);
  });
});

describe("formatTimestamp", () => {
  it("renders an em dash for null", () => {
    expect(formatTimestamp(null)).toBe("—");
  });

  it("renders an em dash rather than 'Invalid Date' for junk", () => {
    expect(formatTimestamp("not a date")).toBe("—");
  });

  it("formats the ISO-8601 the Node API emits", () => {
    expect(formatTimestamp("2026-08-10T08:46:08.500Z")).not.toBe("—");
  });
});
