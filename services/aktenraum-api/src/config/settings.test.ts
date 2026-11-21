import { logServiceCredentialCheck } from "@aktenraum/core";
import { describe, expect, it, vi } from "vitest";

import { apiServiceCredentials } from "../auth/internal.guard.js";
import { TEST_ENV } from "../test/harness.js";
import { loadSettings, webauthnConfigProblems } from "./settings.js";

describe("WebAuthn settings", () => {
  it("defaults to localhost (edge + dev server)", () => {
    const settings = loadSettings({ ...TEST_ENV });
    expect(settings.WEBAUTHN_ORIGINS).toEqual(["http://localhost:8080", "http://localhost:4300"]);
    expect(settings.WEBAUTHN_RP_IDS).toEqual(["localhost"]);
  });

  it("parses comma lists", () => {
    const settings = loadSettings({
      ...TEST_ENV,
      WEBAUTHN_ORIGINS: " http://localhost:8080 , https://box.tail1234.ts.net ",
      WEBAUTHN_RP_IDS: "localhost,box.tail1234.ts.net",
    });
    expect(settings.WEBAUTHN_ORIGINS).toEqual(["http://localhost:8080", "https://box.tail1234.ts.net"]);
    expect(settings.WEBAUTHN_RP_IDS).toEqual(["localhost", "box.tail1234.ts.net"]);
  });

  it("refuses an origin whose host is not an RP ID", () => {
    expect(() =>
      loadSettings({ ...TEST_ENV, WEBAUTHN_ORIGINS: "https://box.tail1234.ts.net", WEBAUTHN_RP_IDS: "localhost" }),
    ).toThrow(/not in WEBAUTHN_RP_IDS/);
  });

  it("refuses IP addresses as origin or RP ID", () => {
    expect(webauthnConfigProblems(["http://192.168.1.5:8080"], ["192.168.1.5"])).toHaveLength(2);
    expect(webauthnConfigProblems(["http://[::1]:8080"], ["localhost"])[0]).toMatch(/IP address/);
    expect(() => loadSettings({ ...TEST_ENV, WEBAUTHN_RP_IDS: "127.0.0.1" })).toThrow(/IP address/);
  });

  it("refuses origins with a path or another scheme", () => {
    expect(webauthnConfigProblems(["http://localhost:8080/app"], ["localhost"])[0]).toMatch(/without a path/);
    expect(webauthnConfigProblems(["ftp://localhost"], ["localhost"])[0]).toMatch(/without a path/);
    expect(webauthnConfigProblems(["http://localhost:8080/"], ["localhost"])).toEqual([]);
  });
});

describe("service credentials", () => {
  const WORKER = "akt_svc_worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const API = "akt_svc_api_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  it("reads SVC_TOKEN_WORKER / SVC_TOKEN_API and no longer reads WEBHOOK_SECRET", () => {
    const settings = loadSettings({ ...TEST_ENV, SVC_TOKEN_WORKER: WORKER, SVC_TOKEN_API: API, WEBHOOK_SECRET: "legacy" });
    expect(apiServiceCredentials(settings)).toEqual({ worker: WORKER, api: API });
    expect(settings).not.toHaveProperty("WEBHOOK_SECRET");
  });

  it("never holds the Paperless hook credential", () => {
    const settings = loadSettings({ ...TEST_ENV, SVC_TOKEN_PAPERLESS_HOOK: "hook-value" });
    expect(Object.keys(apiServiceCredentials(settings))).toEqual(["worker", "api"]);
  });

  it("logs unset credentials at startup", () => {
    const warn = vi.fn();
    logServiceCredentialCheck(apiServiceCredentials(loadSettings({ ...TEST_ENV })), { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe("service_token_unset");
    expect(warn.mock.calls[0]![1]).toMatchObject({ services: ["worker", "api"] });
  });

  it("logs a duplicated value without the value", () => {
    const warn = vi.fn();
    logServiceCredentialCheck(
      apiServiceCredentials(loadSettings({ ...TEST_ENV, SVC_TOKEN_WORKER: API, SVC_TOKEN_API: API })),
      { warn },
    );
    expect(warn.mock.calls.map((c) => c[0])).toEqual(["service_token_duplicate"]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(API);
  });
});
