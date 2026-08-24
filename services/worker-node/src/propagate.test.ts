import { describe, expect, it } from "vitest";
import type { PaperlessDocument } from "@aktenraum/core-ts";

import { docToFields, splitSuggestedTags } from "./propagate.js";

describe("splitSuggestedTags", () => {
  it("splits a comma-separated list and trims each name", () => {
    expect(splitSuggestedTags("Strom, Versicherung ,Steuer")).toEqual([
      "Strom",
      "Versicherung",
      "Steuer",
    ]);
  });

  it("filters out lifecycle names so an LLM suggestion cannot hijack the state machine", () => {
    expect(splitSuggestedTags("Strom,ai-approved,ai-propagated,Steuer")).toEqual([
      "Strom",
      "Steuer",
    ]);
  });

  it("drops fragments truncated by the 128-char field limit", () => {
    expect(splitSuggestedTags("Strom,Eine sehr lange Bezeichnung die abgeschnitten wurde…")).toEqual(
      ["Strom"],
    );
  });

  it("returns nothing for null, empty or whitespace-only input", () => {
    expect(splitSuggestedTags(null)).toEqual([]);
    expect(splitSuggestedTags("")).toEqual([]);
    expect(splitSuggestedTags(" , , ")).toEqual([]);
  });
});

describe("docToFields", () => {
  const names = new Map([
    [10, "ai_correspondent"],
    [11, "ai_document_type"],
    [13, "ai_issue_date"],
    [14, "ai_reference_numbers"],
  ]);

  function doc(customFields: { field: number; value: unknown }[]): PaperlessDocument {
    return { id: 7, custom_fields: customFields } as PaperlessDocument;
  }

  it("projects the dedup anchors off the custom-field array", () => {
    const fields = docToFields(
      doc([
        { field: 10, value: "Vitego" },
        { field: 11, value: "Beleg" },
        { field: 13, value: "2026-07-30" },
      ]),
      names,
    );
    expect(fields).toMatchObject({
      id: 7,
      correspondent: "Vitego",
      documentType: "Beleg",
      issueDate: "2026-07-30",
    });
  });

  it("stringifies a non-string value rather than dropping it", () => {
    expect(docToFields(doc([{ field: 14, value: 4711 }]), names).referenceNumbers).toBe("4711");
  });

  it("ignores unknown field ids and null values", () => {
    const fields = docToFields(
      doc([
        { field: 999, value: "unknown field" },
        { field: 10, value: null },
      ]),
      names,
    );
    expect(fields.correspondent).toBeNull();
  });

  it("returns all-null anchors for a document with no custom fields", () => {
    const fields = docToFields({ id: 1 } as PaperlessDocument, names);
    expect(fields).toEqual({
      id: 1,
      correspondent: null,
      issueDate: null,
      monetaryAmount: null,
      referenceNumbers: null,
      documentType: null,
    });
  });
});
