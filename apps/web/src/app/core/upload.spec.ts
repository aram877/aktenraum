import { describe, expect, it } from "vitest";

import { PHASE_LABEL, phaseFromTags } from "./upload";
import { daysLeft } from "./trash";

describe("phaseFromTags", () => {
  it("stays in flight while no lifecycle tag has landed", () => {
    expect(phaseFromTags([])).toBeNull();
  });

  it("reports the inbox when the doc is pending review", () => {
    expect(phaseFromTags(["ai-pending"])).toBe("inbox");
  });

  it("reports the library once propagated or approved", () => {
    expect(phaseFromTags(["ai-propagated"])).toBe("library");
    expect(phaseFromTags(["ai-approved"])).toBe("library");
  });

  it("reports an error state, and error wins over everything", () => {
    expect(phaseFromTags(["ai-error"])).toBe("error");
    expect(phaseFromTags(["ai-pending", "ai-propagation-error"])).toBe("error");
  });

  it("has a German label for every phase", () => {
    for (const label of Object.values(PHASE_LABEL)) expect(label.length).toBeGreaterThan(0);
  });
});

describe("daysLeft", () => {
  const now = new Date("2026-08-11T12:00:00Z");

  it("counts down from the 30-day purge window", () => {
    expect(daysLeft("2026-08-01T12:00:00Z", now)).toBe(20);
  });

  it("never goes negative once the window has passed", () => {
    expect(daysLeft("2026-01-01T12:00:00Z", now)).toBe(0);
  });

  it("returns null for a missing or unparseable timestamp", () => {
    expect(daysLeft(null, now)).toBeNull();
    expect(daysLeft("nonsense", now)).toBeNull();
  });
});
