import { describe, expect, it } from "vitest";

import { toIsoTimestamp } from "./settings.service.js";

describe("toIsoTimestamp", () => {
  it("converts Postgres's space-separated timestamptz to ISO-8601", () => {
    expect(toIsoTimestamp("2026-08-10 08:46:08.5+00")).toBe("2026-08-10T08:46:08.500Z");
  });

  it("handles a two-digit non-zero offset", () => {
    expect(toIsoTimestamp("2026-08-10 10:46:08+02")).toBe("2026-08-10T08:46:08.000Z");
  });

  it("handles a four-digit offset", () => {
    expect(toIsoTimestamp("2026-08-10 10:16:08+0230")).toBe("2026-08-10T07:46:08.000Z");
  });

  it("passes an already-ISO value through unchanged in meaning", () => {
    expect(toIsoTimestamp("2026-08-10T08:46:08.500Z")).toBe("2026-08-10T08:46:08.500Z");
  });

  it("returns null for null and empty input", () => {
    expect(toIsoTimestamp(null)).toBeNull();
    expect(toIsoTimestamp("")).toBeNull();
  });

  it("returns null rather than throwing on an unparseable value", () => {
    expect(toIsoTimestamp("not a timestamp")).toBeNull();
  });

  it("produces a value the browser Date constructor accepts", () => {
    const iso = toIsoTimestamp("2026-08-10 08:46:08.5+00");
    expect(iso).not.toBeNull();
    expect(Number.isNaN(new Date(iso as string).getTime())).toBe(false);
  });
});
