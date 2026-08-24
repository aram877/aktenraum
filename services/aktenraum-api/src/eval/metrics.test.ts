import { describe, expect, it } from "vitest";

import { aggregate, scoreCase, type EvalCase } from "./metrics.js";

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "c1",
    question: "q",
    expected: [7],
    expectedInTopK: 5,
    language: "de",
    ...overrides,
  };
}

describe("scoreCase", () => {
  it("scores a rank-1 hit as reciprocal rank 1", () => {
    const r = scoreCase(makeCase(), [7, 8, 9]);
    expect(r.rankOfFirstHit).toBe(1);
    expect(r.reciprocalRank).toBe(1);
    expect(r.hitAtK).toBe(true);
  });

  it("scores a rank-3 hit as one third", () => {
    const r = scoreCase(makeCase(), [1, 2, 7]);
    expect(r.reciprocalRank).toBeCloseTo(1 / 3);
    expect(r.hitAtK).toBe(true);
  });

  it("counts a hit beyond K as a miss but keeps the reciprocal rank", () => {
    const r = scoreCase(makeCase({ expectedInTopK: 2 }), [1, 2, 7]);
    expect(r.hitAtK).toBe(false);
    expect(r.reciprocalRank).toBeCloseTo(1 / 3);
  });

  it("scores an empty retrieval as a hard zero", () => {
    const r = scoreCase(makeCase(), []);
    expect(r.rankOfFirstHit).toBeNull();
    expect(r.reciprocalRank).toBe(0);
    expect(r.hitAtK).toBe(false);
  });

  it("accepts any of several expected ids", () => {
    expect(scoreCase(makeCase({ expected: [4, 7] }), [9, 4]).rankOfFirstHit).toBe(2);
  });

  it("does not re-dedupe, so a buggy upstream shows up as bad MRR", () => {
    expect(scoreCase(makeCase(), [3, 3, 7]).rankOfFirstHit).toBe(3);
  });
});

describe("aggregate", () => {
  it("returns a zeroed report for no cases rather than dividing by zero", () => {
    expect(aggregate([])).toEqual({
      totalCases: 0,
      hits: 0,
      misses: 0,
      recallAtK: 0,
      mrr: 0,
      perCase: [],
    });
  });

  it("averages recall and MRR across cases", () => {
    const report = aggregate([
      scoreCase(makeCase({ id: "a" }), [7]),
      scoreCase(makeCase({ id: "b" }), [1, 2, 3, 4, 5, 7]),
    ]);
    expect(report.totalCases).toBe(2);
    expect(report.hits).toBe(1);
    expect(report.recallAtK).toBe(0.5);
    expect(report.mrr).toBeCloseTo((1 + 1 / 6) / 2);
  });
});
