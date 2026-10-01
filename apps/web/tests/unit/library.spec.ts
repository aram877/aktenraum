import { describe, expect, it } from "vitest";

import { sortTagsImportantFirst, toQueryString, totalPages } from "~/utils/library";
import { userFacingTags } from "~/utils/lifecycle-tags";

describe("toQueryString", () => {
  it("repeats the key for array values, matching FastAPI's list[str] Query", () => {
    expect(toQueryString({ tags: ["a", "b"] })).toBe("tags=a&tags=b");
  });

  it("drops null, undefined and empty values", () => {
    expect(toQueryString({ text: null, correspondent: "", document_type: "Rechnung" })).toBe(
      "document_type=Rechnung",
    );
  });

  it("drops empty entries inside an array", () => {
    expect(toQueryString({ tags: ["a", "", "b"] })).toBe("tags=a&tags=b");
  });

  it("encodes umlauts so Kündigung survives the round trip", () => {
    expect(toQueryString({ document_type: "Kündigung" })).toBe(
      "document_type=K%C3%BCndigung",
    );
  });
});

describe("sortTagsImportantFirst", () => {
  it("pins wichtig to the front", () => {
    expect(sortTagsImportantFirst(["Steuer", "wichtig", "Auto"])).toEqual([
      "wichtig",
      "Auto",
      "Steuer",
    ]);
  });

  it("sorts the rest with German collation", () => {
    expect(sortTagsImportantFirst(["Zeugnis", "Ärztlich", "Auto"])).toEqual([
      "Ärztlich",
      "Auto",
      "Zeugnis",
    ]);
  });

  it("does not mutate the input", () => {
    const input = ["b", "wichtig"];
    sortTagsImportantFirst(input);
    expect(input).toEqual(["b", "wichtig"]);
  });
});

describe("userFacingTags", () => {
  it("hides every internal lifecycle and auxiliary tag", () => {
    expect(
      userFacingTags([
        "ai-propagated",
        "ai-duplicate",
        "ai-duplicate-dismissed",
        "ai-low-confidence",
        "wichtig",
        "Steuer",
      ]),
    ).toEqual(["wichtig", "Steuer"]);
  });
});

describe("totalPages", () => {
  it("never reports zero pages for an empty result set", () => {
    expect(totalPages(0, 25)).toBe(1);
  });

  it("rounds a partial page up", () => {
    expect(totalPages(26, 25)).toBe(2);
    expect(totalPages(25, 25)).toBe(1);
  });
});
