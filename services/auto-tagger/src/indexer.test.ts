import { describe, expect, it } from "vitest";

import { filterUserTags, INDEX_ERROR_TAG, parseDateOnly } from "./indexer.js";

describe("filterUserTags", () => {
  const map = new Map([
    [1, "ai-pending"],
    [2, "ai-propagated"],
    [3, "ai-low-confidence"],
    [4, INDEX_ERROR_TAG],
    [5, "wichtig"],
    [6, "Versicherung"],
  ]);

  it("keeps only user-facing topical tags", () => {
    expect(filterUserTags([1, 2, 5, 6], map)).toEqual(["wichtig", "Versicherung"]);
  });

  it("excludes ai-index-error so the indexer's own failure tag never enters the payload", () => {
    expect(filterUserTags([4, 6], map)).toEqual(["Versicherung"]);
  });

  it("excludes ai-low-confidence", () => {
    expect(filterUserTags([3, 5], map)).toEqual(["wichtig"]);
  });

  it("skips ids missing from the map rather than emitting undefined", () => {
    expect(filterUserTags([999, 5], map)).toEqual(["wichtig"]);
  });

  it("returns nothing for a document with only lifecycle tags", () => {
    expect(filterUserTags([1, 2, 3, 4], map)).toEqual([]);
  });
});

describe("parseDateOnly", () => {
  it("takes the date part of a full ISO timestamp", () => {
    expect(parseDateOnly("2026-03-15T10:00:00Z")).toBe("2026-03-15");
  });

  it("passes a bare date through", () => {
    expect(parseDateOnly("2026-03-15")).toBe("2026-03-15");
  });

  it("returns null for junk, null and short strings", () => {
    expect(parseDateOnly("irgendwann")).toBeNull();
    expect(parseDateOnly(null)).toBeNull();
    expect(parseDateOnly("2026-03")).toBeNull();
    expect(parseDateOnly(20260315)).toBeNull();
  });
});
