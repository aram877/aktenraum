import { describe, expect, it } from "vitest";

import { isCsrfAllowed, needsCsrfCheck } from "./middleware.js";

function allowed(
  method: string,
  path: string,
  secFetchSite?: string,
  hasInternalSecret = false,
): boolean {
  return isCsrfAllowed({ method, path, secFetchSite, hasInternalSecret });
}

describe("needsCsrfCheck", () => {
  it("checks every state-changing method", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(needsCsrfCheck(method, "/api/inbox/1/approve")).toBe(true);
    }
  });

  it("does not check a plain GET", () => {
    expect(needsCsrfCheck("GET", "/api/library/")).toBe(false);
  });

  it("checks the binary-returning GETs", () => {
    expect(needsCsrfCheck("GET", "/api/documents/42/preview")).toBe(true);
    expect(needsCsrfCheck("GET", "/api/documents/42/download")).toBe(true);
  });

  it("exempts health and the openapi docs", () => {
    expect(needsCsrfCheck("POST", "/api/health")).toBe(false);
    expect(needsCsrfCheck("POST", "/api/openapi.json")).toBe(false);
    expect(needsCsrfCheck("POST", "/api/docs")).toBe(false);
  });
});

describe("isCsrfAllowed", () => {
  it("allows same-origin, same-site, and none", () => {
    for (const site of ["same-origin", "same-site", "none"]) {
      expect(allowed("POST", "/api/inbox/1/approve", site)).toBe(true);
    }
  });

  it("blocks an explicit cross-site state change", () => {
    expect(allowed("POST", "/api/inbox/1/approve", "cross-site")).toBe(false);
  });

  it("blocks a cross-site preview fetch", () => {
    expect(allowed("GET", "/api/documents/42/preview", "cross-site")).toBe(false);
  });

  it("allows a request with no Sec-Fetch-Site at all (curl, server-to-server)", () => {
    expect(allowed("POST", "/api/inbox/1/approve", undefined)).toBe(true);
  });

  it("lets an internal caller through even when marked cross-site", () => {
    expect(allowed("POST", "/api/settings/active-llm-model", "cross-site", true)).toBe(true);
  });

  it("never blocks a plain GET regardless of site", () => {
    expect(allowed("GET", "/api/library/", "cross-site")).toBe(true);
  });

  it("never blocks health even cross-site", () => {
    expect(allowed("POST", "/api/health", "cross-site")).toBe(true);
  });
});
