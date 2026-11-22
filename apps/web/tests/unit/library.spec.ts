import { describe, expect, it } from "vitest";

import {
  familyCounts,
  formatDocDate,
  groupByMonth,
  libraryTypeFilter,
  rowStatus,
  sortTagsImportantFirst,
  tagSummary,
  toQueryString,
  totalPages,
} from "~/utils/library";
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

describe("library redesign helpers", () => {
  it("prefers an explicit type over its area", () => {
    expect(libraryTypeFilter("mobil", "")).toEqual(["Kfz", "Bußgeldbescheid"]);
    expect(libraryTypeFilter("mobil", "Kfz")).toEqual(["Kfz"]);
    expect(libraryTypeFilter("", "")).toBeNull();
    expect(libraryTypeFilter("nope", "")).toBeNull();
  });

  it("sums the type facet per area, unknown names under Sonstiges", () => {
    const counts = familyCounts([
      { name: "Rechnung", count: 10 },
      { name: "Mahnung", count: 2 },
      { name: "Quittung", count: 3 },
      { name: "Kfz", count: 0 },
    ]);
    expect(counts).toHaveLength(9);
    expect(counts.find((c) => c.family.key === "geld")).toMatchObject({ count: 12 });
    expect(counts.find((c) => c.family.key === "sonst")?.types).toEqual([{ name: "Quittung", count: 3 }]);
    expect(counts.find((c) => c.family.key === "mobil")?.count).toBe(0);
  });

  it("formats document dates", () => {
    expect(formatDocDate("2026-11-18")).toBe("18.11.2026");
    expect(formatDocDate("2026-11-18T10:00:00Z")).toBe("18.11.2026");
    expect(formatDocDate(null)).toBe("—");
  });

  it("groups by month only when sorted by document date", () => {
    const rows = [{ created: "2026-11-18" }, { created: "2026-11-02" }, { created: "2026-10-30" }, { created: null }];
    const groups = groupByMonth(rows, "-created");
    expect(groups.map((g) => [g.label, g.rows.length])).toEqual([
      ["November 2026", 2],
      ["Oktober 2026", 1],
      ["Ohne Datum", 1],
    ]);
    expect(groupByMonth(rows, "title")).toEqual([{ key: "all", label: null, rows }]);
  });

  it("shows a status only when the row needs attention", () => {
    expect(rowStatus(["ai-propagated"], null, false)).toBeNull();
    expect(rowStatus(["ai-auto-approved", "ai-propagated"], null, false)).toBeNull();
    expect(rowStatus(["ai-rejected"], null, false)).toBeNull();
    expect(rowStatus(["ai-error"], "boom", false)).toMatchObject({ label: "Fehler", tone: "danger" });
    expect(rowStatus(["ai-pending"], null, false)).toMatchObject({ label: "Prüfen", tone: "warning" });
    expect(rowStatus(["ai-approved"], null, false)).toMatchObject({ label: "Wird übertragen", tone: "info" });
    expect(rowStatus([], null, false)).toMatchObject({ label: "Wartet auf KI" });
    expect(rowStatus(["ai-propagated"], null, true)).toMatchObject({ label: "KI läuft" });
  });

  it("summarises tags as a star plus the rest", () => {
    expect(tagSummary(["Strom", "wichtig", "ai-propagated", "Wohnung"])).toEqual({ star: true, others: ["Strom", "Wohnung"] });
    expect(tagSummary(["ai-propagated"])).toEqual({ star: false, others: [] });
  });
});
