import { describe, expect, it } from "vitest";

import { formatReport, parseCases } from "./runner.js";
import { aggregate, scoreCase } from "./metrics.js";

const SAMPLE = `
# a comment line
- id: cv-employment
  question: "Wie lange habe ich bei Kopfstand gearbeitet?"
  expected_doc_ids: [25]
  expected_in_top_k: 5
  category: cv-employment
  language: de

- id: two-valid-answers
  question: "Was kostet die Versicherung?"
  expected_doc_ids: [11, 12]
`;

describe("parseCases", () => {
  it("reads every case", () => {
    expect(parseCases(SAMPLE)).toHaveLength(2);
  });

  it("keeps the German question text including umlauts", () => {
    expect(parseCases(SAMPLE)[0]?.question).toBe(
      "Wie lange habe ich bei Kopfstand gearbeitet?",
    );
  });

  it("parses single and multi-id expectations", () => {
    const cases = parseCases(SAMPLE);
    expect(cases[0]?.expected).toEqual([25]);
    expect(cases[1]?.expected).toEqual([11, 12]);
  });

  it("defaults expected_in_top_k to 5 when omitted", () => {
    expect(parseCases(SAMPLE)[1]?.expectedInTopK).toBe(5);
  });

  it("ignores comments and blank lines", () => {
    expect(parseCases("# only a comment\n\n")).toEqual([]);
  });
});

describe("formatReport", () => {
  it("reports the headline metrics", () => {
    const out = formatReport(
      aggregate([
        scoreCase(
          { id: "a", question: "q", expected: [1], expectedInTopK: 5, language: "de" },
          [1],
        ),
      ]),
    );
    expect(out).toContain("recall@K   1.000");
    expect(out).toContain("MRR        1.000");
    expect(out).toContain("HIT");
  });
});
