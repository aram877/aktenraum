import { describe, expect, it } from "vitest";
import { type DocFields, findDuplicates } from "./dedup.js";

// Mirrors services/auto-tagger/tests/test_dedup.py.

function doc(
  id: number,
  overrides: {
    correspondent?: string | null;
    issueDate?: string | null;
    monetaryAmount?: string | null;
    referenceNumbers?: string | null;
    documentType?: string | null;
  } = {},
): DocFields {
  // NOTE: `??` would treat an explicitly-passed `null` the same as "not
  // provided" (both are nullish), which breaks every test that overrides a
  // field to null on purpose. Use `in` to distinguish "key present" from
  // "key omitted" instead.
  return {
    id,
    correspondent: "correspondent" in overrides ? overrides.correspondent : "Telekom",
    issueDate: "issueDate" in overrides ? overrides.issueDate : "2024-03-15",
    monetaryAmount: "monetaryAmount" in overrides ? overrides.monetaryAmount : "EUR42.99",
    referenceNumbers: "referenceNumbers" in overrides ? overrides.referenceNumbers : null,
    documentType: "documentType" in overrides ? overrides.documentType : null,
  };
}

describe("findDuplicates — exact match", () => {
  it("flags same correspondent/date/amount", () => {
    const a = doc(1);
    const b = doc(2);
    expect(findDuplicates(b, [a])).toEqual([1]);
  });

  it("excludes the doc's own id if mis-fed into the candidate list", () => {
    const a = doc(1);
    expect(findDuplicates(a, [a])).toEqual([]);
  });

  it("returns empty for empty candidates", () => {
    expect(findDuplicates(doc(1), [])).toEqual([]);
  });

  it("returns multiple matches in iteration order", () => {
    const newDoc = doc(99);
    const cands = [doc(1), doc(2), doc(3)];
    expect(findDuplicates(newDoc, cands)).toEqual([1, 2, 3]);
  });
});

describe("findDuplicates — correspondent mismatch", () => {
  it("does not flag different correspondents", () => {
    const a = doc(1, { correspondent: "Telekom" });
    const b = doc(2, { correspondent: "Vodafone" });
    expect(findDuplicates(b, [a])).toEqual([]);
  });

  it("normalises correspondent case and whitespace", () => {
    const a = doc(1, { correspondent: "  Telekom  " });
    const b = doc(2, { correspondent: "TELEKOM" });
    expect(findDuplicates(b, [a])).toEqual([1]);
  });

  it("case-folds the German eszett", () => {
    // ß -> ss so receipts that vary on Eszett still match.
    const a = doc(1, { correspondent: "Großhändler" });
    const b = doc(2, { correspondent: "grosshändler" });
    expect(findDuplicates(b, [a])).toEqual([1]);
  });
});

describe("findDuplicates — missing anchors", () => {
  it("skips detection when the new doc has no correspondent", () => {
    const newDoc = doc(99, { correspondent: null });
    const cands = [doc(1), doc(2)];
    expect(findDuplicates(newDoc, cands)).toEqual([]);
  });

  it("skips detection when the new doc has no issue date", () => {
    const newDoc = doc(99, { issueDate: null });
    const cands = [doc(1), doc(2)];
    expect(findDuplicates(newDoc, cands)).toEqual([]);
  });

  it("treats an empty correspondent string as missing", () => {
    const newDoc = doc(99, { correspondent: "   " });
    expect(findDuplicates(newDoc, [doc(1)])).toEqual([]);
  });

  it("falls through to refs when the candidate is missing an amount", () => {
    const newDoc = doc(99, { monetaryAmount: null, referenceNumbers: "RN-12345" });
    const cand = doc(1, { monetaryAmount: null, referenceNumbers: "RN-12345" });
    expect(findDuplicates(newDoc, [cand])).toEqual([1]);
  });
});

describe("findDuplicates — amount tolerance", () => {
  it("flags amounts within tolerance", () => {
    const a = doc(1, { monetaryAmount: "EUR42.99" });
    const b = doc(2, { monetaryAmount: "EUR43.00" }); // 1 cent diff, at tolerance
    expect(findDuplicates(b, [a])).toEqual([1]);
  });

  it("does not flag amounts outside tolerance without a ref overlap", () => {
    const a = doc(1, { monetaryAmount: "EUR42.99" });
    const b = doc(2, { monetaryAmount: "EUR43.50" }); // 51 cents diff
    expect(findDuplicates(b, [a])).toEqual([]);
  });

  it("flags amounts outside tolerance when refs overlap (OR semantics)", () => {
    const a = doc(1, { monetaryAmount: "EUR42.99", referenceNumbers: "RN-7" });
    const b = doc(2, { monetaryAmount: "EUR9999.00", referenceNumbers: "RN-7" });
    expect(findDuplicates(b, [a])).toEqual([1]);
  });

  it("handles the currency prefix", () => {
    const a = doc(1, { monetaryAmount: "USD42.99" });
    const b = doc(2, { monetaryAmount: "USD42.99" });
    expect(findDuplicates(b, [a])).toEqual([1]);
  });

  it("falls through to refs when the amount is unparseable", () => {
    const a = doc(1, { monetaryAmount: "not-a-number", referenceNumbers: "RN-1" });
    const b = doc(2, { monetaryAmount: "EUR1.00", referenceNumbers: "RN-1" });
    expect(findDuplicates(b, [a])).toEqual([1]);
  });

  it("does not flag when the amount is unparseable and there is no ref overlap", () => {
    const a = doc(1, { monetaryAmount: "not-a-number", referenceNumbers: null });
    const b = doc(2, { monetaryAmount: "EUR1.00", referenceNumbers: null });
    expect(findDuplicates(b, [a])).toEqual([]);
  });
});

describe("findDuplicates — reference numbers", () => {
  it("flags on a shared ref alone", () => {
    const a = doc(1, { monetaryAmount: "EUR1.00", referenceNumbers: "RN-1" });
    const b = doc(2, { monetaryAmount: "EUR2.00", referenceNumbers: "RN-1, RN-2" });
    expect(findDuplicates(b, [a])).toEqual([1]);
  });

  it("does not flag when refs don't overlap and amounts mismatch", () => {
    const a = doc(1, { monetaryAmount: "EUR1.00", referenceNumbers: "RN-1" });
    const b = doc(2, { monetaryAmount: "EUR99.00", referenceNumbers: "RN-99" });
    expect(findDuplicates(b, [a])).toEqual([]);
  });

  it("matches refs case-insensitively and trimmed", () => {
    const a = doc(1, { referenceNumbers: "  RN-001 ,  AZ-77" });
    const b = doc(2, { referenceNumbers: "rn-001" });
    expect(findDuplicates(b, [a])).toEqual([1]);
  });

  it("drops empty ref fragments so a stray comma doesn't smuggle an empty match", () => {
    const a = doc(1, { monetaryAmount: null, referenceNumbers: "RN-1," });
    const b = doc(2, { monetaryAmount: null, referenceNumbers: ",,," });
    expect(findDuplicates(b, [a])).toEqual([]);
  });
});

describe("findDuplicates — date matching", () => {
  it("does not flag different dates", () => {
    const a = doc(1, { issueDate: "2024-03-15" });
    const b = doc(2, { issueDate: "2024-03-16" });
    expect(findDuplicates(b, [a])).toEqual([]);
  });

  it("compares dates as strict strings, not normalised", () => {
    // Stored dates are guaranteed ISO from the gateway normaliser; if the
    // formats diverge that's a separate bug. Verify strict equality.
    const a = doc(1, { issueDate: "2024-03-15" });
    const b = doc(2, { issueDate: "2024-3-15" });
    expect(findDuplicates(b, [a])).toEqual([]);
  });
});

describe("findDuplicates — candidate exclusion", () => {
  it("drops a candidate missing a correspondent", () => {
    const newDoc = doc(99);
    const cand = doc(1, { correspondent: null });
    expect(findDuplicates(newDoc, [cand])).toEqual([]);
  });

  it("drops a candidate missing a date", () => {
    const newDoc = doc(99);
    const cand = doc(1, { issueDate: null });
    expect(findDuplicates(newDoc, [cand])).toEqual([]);
  });
});

describe("findDuplicates — document type discriminator", () => {
  // A Rechnung and its Beleg (payment proof) from the same vendor on the
  // same day for the same amount should NOT be flagged as duplicates —
  // they're related but distinct records of the same transaction.

  it("does not match different types despite the same amount", () => {
    const rechnung = doc(1, { documentType: "Rechnung" });
    const beleg = doc(2, { documentType: "Beleg" });
    expect(findDuplicates(beleg, [rechnung])).toEqual([]);
    expect(findDuplicates(rechnung, [beleg])).toEqual([]);
  });

  it("does not match different types despite shared refs", () => {
    // Even if a Beleg references the Rechnung's number, the type
    // discriminator wins — type-awareness beats ref-overlap heuristics.
    const rechnung = doc(1, { documentType: "Rechnung", referenceNumbers: "INV-123" });
    const beleg = doc(2, { documentType: "Beleg", referenceNumbers: "INV-123" });
    expect(findDuplicates(beleg, [rechnung])).toEqual([]);
  });

  it("still matches when types are the same", () => {
    const a = doc(1, { documentType: "Rechnung" });
    const b = doc(2, { documentType: "Rechnung" });
    expect(findDuplicates(b, [a])).toEqual([1]);
  });

  it("skips the type check when the type is missing on one side", () => {
    // Backward compat: corpora indexed before this signal existed have
    // null document_type. Don't block the match.
    const a = doc(1, { documentType: null });
    const b = doc(2, { documentType: "Rechnung" });
    expect(findDuplicates(b, [a])).toEqual([1]);
  });

  it("skips the type check when the type is missing on both sides", () => {
    const a = doc(1, { documentType: null });
    const b = doc(2, { documentType: null });
    expect(findDuplicates(b, [a])).toEqual([1]);
  });

  it("matches type case-insensitively", () => {
    // Defence in depth: if a doc somehow stored its type in a different
    // case (it shouldn't — the enum is exact-string) it should still match.
    const a = doc(1, { documentType: "rechnung" });
    const b = doc(2, { documentType: "Rechnung" });
    expect(findDuplicates(b, [a])).toEqual([1]);
  });
});
