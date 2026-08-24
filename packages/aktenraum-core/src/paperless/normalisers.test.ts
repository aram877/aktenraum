import { describe, expect, it } from "vitest";
import { LONGTEXT_FIELDS, normalizeDate, normalizeMonetary, truncateForField } from "./normalisers.js";

// Mirrors services/auto-tagger/tests/test_paperless.py's normaliser test
// classes — same cases, ported 1:1 for parity.

describe("normalizeMonetary", () => {
  it.each([
    ["149,99 EUR", "EUR149.99"],
    ["EUR 149,99", "EUR149.99"],
    ["EUR149.99", "EUR149.99"],
    ["1.234,56 EUR", "EUR1234.56"],
    ["USD 1,234.56", "USD1234.56"],
    ["149.99 USD", "USD149.99"],
    ["€149,99", "EUR149.99"],
    ["$149.99", "USD149.99"],
    ["£149.99", "GBP149.99"],
    ["0,00 EUR", "EUR0.00"],
    ["-50,00 EUR", "EUR-50.00"],
    ["12,5 EUR", "EUR12.50"],
  ])("normalises %s to %s", (value, expected) => {
    expect(normalizeMonetary(value)).toBe(expected);
  });

  it.each([null, "", "   ", "Beträge variieren", "abc", "EUR"])(
    "returns null for unparseable value %s",
    (value) => {
      expect(normalizeMonetary(value)).toBeNull();
    },
  );

  it("defaults to EUR when no currency marker is present", () => {
    // No code, no symbol — caller is German DMS, EUR is the safe default.
    expect(normalizeMonetary("149,99")).toBe("EUR149.99");
  });
});

describe("truncateForField", () => {
  it("passes null through for both longtext and string fields", () => {
    expect(truncateForField("ai_summary_de", null)).toBeNull();
    expect(truncateForField("ai_correspondent", null)).toBeNull();
  });

  it("leaves short strings unchanged", () => {
    expect(truncateForField("ai_correspondent", "hello")).toBe("hello");
  });

  it("leaves empty strings unchanged", () => {
    expect(truncateForField("ai_correspondent", "")).toBe("");
  });

  it("leaves a string exactly at the 128-char limit unchanged", () => {
    const s = "x".repeat(128);
    const result = truncateForField("ai_correspondent", s);
    expect(result).toBe(s);
    expect(result?.length).toBe(128);
  });

  it("truncates a string one char over the limit", () => {
    const s = "x".repeat(129);
    const result = truncateForField("ai_correspondent", s);
    expect(result?.length).toBe(128);
    expect(result?.endsWith("…")).toBe(true);
  });

  it("truncates a long string with an ellipsis", () => {
    const s = "x".repeat(500);
    const result = truncateForField("ai_correspondent", s);
    expect(result?.length).toBe(128);
    expect(result?.endsWith("…")).toBe(true);
    expect(result?.slice(0, -1)).toBe("x".repeat(127));
  });

  it("does not truncate a longtext field", () => {
    const longSummary = "Bei dem vorliegenden Dokument handelt es sich um eine Teilnahmebescheinigung. ".repeat(8);
    expect(longSummary.length).toBeGreaterThan(128);
    expect(truncateForField("ai_summary_de", longSummary)).toBe(longSummary);
  });

  it("still truncates a string-type field even at similar length", () => {
    const long = "x".repeat(200);
    const out = truncateForField("ai_correspondent", long);
    expect(out?.length).toBe(128);
    expect(out?.endsWith("…")).toBe(true);
  });

  it("keeps the longtext set explicit and small", () => {
    // Intentionally tiny — adding a longtext field requires a paired
    // bootstrap-script change, so this test should flinch if someone widens
    // the set without thinking.
    expect(new Set(LONGTEXT_FIELDS)).toEqual(
      new Set(["ai_summary_de", "ai_error_message", "ai_confidence_reason"]),
    );
  });
});

describe("normalizeDate", () => {
  it.each([
    ["2024-12-01", "2024-12-01"], // already canonical
    ["01.12.2024", "2024-12-01"], // German full
    ["01/12/2024", "2024-12-01"], // European slash
    ["2024/12/01", "2024-12-01"], // ISO with slashes
    ["01.12.24", "2024-12-01"], // German short year
    ["12.2024", "2024-12-01"], // German month-year -> anchor to day 1
    ["12/2024", "2024-12-01"],
    ["2024-12", "2024-12-01"], // ISO month-year
    ["  2024-12-01  ", "2024-12-01"], // trim whitespace
  ])("normalises %s to %s", (value, expected) => {
    expect(normalizeDate(value)).toBe(expected);
  });

  it.each([null, "", "   ", "December 2024", "Dezember 2024", "abc", "13/13/2024"])(
    "returns null for unparseable value %s",
    (value) => {
      expect(normalizeDate(value)).toBeNull();
    },
  );
});
