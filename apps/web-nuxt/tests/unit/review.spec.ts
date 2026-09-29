import { describe, expect, it } from "vitest";

import {
  formatConfidence,
  nextPageParam,
  pruneSelection,
  runWithConcurrency,
  type InboxList,
} from "~/utils/review-form";

function page(results: number[], total: number, pageNo: number): InboxList {
  return {
    results: results.map((id) => ({
      id,
      title: `t${id}`,
      original_file_name: null,
      created: null,
      added: null,
      ai_correspondent: null,
      ai_document_type: null,
      ai_title: null,
      ai_issue_date: null,
      ai_confidence: null,
      low_confidence: false,
      ai_error_message: null,
    })),
    total,
    page: pageNo,
    page_size: 50,
  };
}

describe("pruneSelection", () => {
  it("drops ids that are no longer visible after a refetch", () => {
    expect([...pruneSelection(new Set([1, 2, 3]), [1, 3])]).toEqual([1, 3]);
  });

  it("keeps the selection intact when nothing is visible yet", () => {
    expect([...pruneSelection(new Set([1, 2]), [])]).toEqual([1, 2]);
  });

  it("returns a copy rather than the original set", () => {
    const original = new Set([1]);
    expect(pruneSelection(original, [1])).not.toBe(original);
  });
});

describe("nextPageParam", () => {
  it("asks for the next page while fewer rows are loaded than the total", () => {
    expect(nextPageParam(page([1, 2], 5, 1), [page([1, 2], 5, 1)])).toBe(2);
  });

  it("stops once every row is loaded", () => {
    const p1 = page([1, 2], 4, 1);
    const p2 = page([3, 4], 4, 2);
    expect(nextPageParam(p2, [p1, p2])).toBeUndefined();
  });

  it("stops on an empty result set rather than looping forever", () => {
    expect(nextPageParam(page([], 0, 1), [page([], 0, 1)])).toBeUndefined();
  });
});

describe("runWithConcurrency", () => {
  it("processes every item and preserves input order in the results", async () => {
    const out = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });

  it("never exceeds the concurrency ceiling", async () => {
    let active = 0;
    let peak = 0;
    await runWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active -= 1;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("handles an empty list without spawning lanes", async () => {
    expect(await runWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

describe("formatConfidence", () => {
  it("renders a percentage", () => {
    expect(formatConfidence(0.87)).toBe("87 %");
  });

  it("renders an em dash for a missing score", () => {
    expect(formatConfidence(null)).toBe("—");
  });
});
