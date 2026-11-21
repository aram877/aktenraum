import { describe, expect, it } from "vitest";

import { bearerValue, checkServiceCredentials, secretMatches, serviceCaller } from "./secrets.js";

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

const HOOK = "akt_svc_hook0000000000000000000000000000000000000";
const WORKER = "akt_svc_worker00000000000000000000000000000000000";
const API = "akt_svc_api000000000000000000000000000000000000000";
const ALL = { "paperless-hook": HOOK, worker: WORKER, api: API };

describe("bearerValue", () => {
  it("parses Bearer with any scheme case", () => {
    expect(bearerValue(`Bearer ${API}`)).toBe(API);
    expect(bearerValue(`bearer ${API}`)).toBe(API);
    expect(bearerValue(`BEARER ${API}`)).toBe(API);
  });

  it("rejects other schemes, missing values and extra whitespace", () => {
    expect(bearerValue(`Basic ${API}`)).toBeNull();
    expect(bearerValue("Bearer")).toBeNull();
    expect(bearerValue("Bearer ")).toBeNull();
    expect(bearerValue(`Bearer  ${API}`)).toBeNull();
    expect(bearerValue(`Bearer ${API} extra`)).toBeNull();
    expect(bearerValue(API)).toBeNull();
  });

  it("rejects non-string headers", () => {
    expect(bearerValue(undefined)).toBeNull();
    expect(bearerValue([`Bearer ${API}`, `Bearer ${API}`])).toBeNull();
  });
});

describe("serviceCaller", () => {
  it("names the matching caller", () => {
    expect(serviceCaller(`Bearer ${HOOK}`, ALL)).toBe("paperless-hook");
    expect(serviceCaller(`Bearer ${WORKER}`, ALL)).toBe("worker");
    expect(serviceCaller(`bearer ${API}`, ALL)).toBe("api");
  });

  it("returns null for an unknown value, a missing header or an array", () => {
    expect(serviceCaller("Bearer akt_svc_nope", ALL)).toBeNull();
    expect(serviceCaller(undefined, ALL)).toBeNull();
    expect(serviceCaller([`Bearer ${API}`], ALL)).toBeNull();
    expect(serviceCaller(API, ALL)).toBeNull();
  });

  it("only knows the credentials it was given", () => {
    expect(serviceCaller(`Bearer ${HOOK}`, { worker: WORKER })).toBeNull();
    expect(serviceCaller(`Bearer ${WORKER}`, { worker: WORKER })).toBe("worker");
  });

  it("never matches an unset credential", () => {
    expect(serviceCaller("Bearer x", { worker: "" })).toBeNull();
    expect(serviceCaller("Bearer x", { worker: undefined })).toBeNull();
  });

  it("refuses a value shared by two credentials", () => {
    const creds = { "paperless-hook": HOOK, worker: API, api: API };
    expect(serviceCaller(`Bearer ${API}`, creds)).toBeNull();
    expect(serviceCaller(`Bearer ${HOOK}`, creds)).toBe("paperless-hook");
  });
});

describe("checkServiceCredentials", () => {
  it("is clean for three distinct strong credentials", () => {
    expect(checkServiceCredentials(ALL)).toEqual({ unset: [], duplicate: [], weak: [] });
  });

  it("reports unset credentials", () => {
    expect(checkServiceCredentials({ "paperless-hook": "", worker: WORKER, api: undefined }).unset)
      .toEqual(["paperless-hook", "api"]);
  });

  it("reports both sides of a duplicate", () => {
    expect(checkServiceCredentials({ "paperless-hook": HOOK, worker: API, api: API }).duplicate)
      .toEqual(["worker", "api"]);
  });

  it("reports weak credentials", () => {
    expect(checkServiceCredentials({ worker: "short", api: API }).weak).toEqual(["worker"]);
  });

  it("only checks the keys it is given", () => {
    expect(checkServiceCredentials({ worker: WORKER })).toEqual({ unset: [], duplicate: [], weak: [] });
  });
});
