import { describe, expect, it } from "vitest";

import { secretMatches } from "./secrets.js";

describe("secretMatches", () => {
  it("accepts the exact secret", () => {
    expect(secretMatches("s3cret", "s3cret")).toBe(true);
  });

  it("rejects a wrong secret of the same length", () => {
    expect(secretMatches("s3creT", "s3cret")).toBe(false);
  });

  it("rejects a secret of a different length without throwing", () => {
    expect(secretMatches("short", "muchlongersecret")).toBe(false);
    expect(secretMatches("s3cret-and-more", "s3cret")).toBe(false);
  });

  it("fails closed when no secret is configured", () => {
    expect(secretMatches("", "")).toBe(false);
    expect(secretMatches("anything", "")).toBe(false);
  });

  it("rejects non-string header values", () => {
    expect(secretMatches(undefined, "s3cret")).toBe(false);
    expect(secretMatches(["s3cret", "s3cret"], "s3cret")).toBe(false);
    expect(secretMatches(null, "s3cret")).toBe(false);
  });
});
