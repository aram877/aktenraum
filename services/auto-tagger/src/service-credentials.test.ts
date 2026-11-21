import { describe, expect, it, vi } from "vitest";

import { loadSettings } from "./config.js";
import { logServiceCredentialCheck } from "@aktenraum/core";
import { workerServiceCredentials } from "./service-credentials.js";

const BASE = { PAPERLESS_BASE_URL: "http://p", PAPERLESS_API_TOKEN: "t" };
const HOOK = "akt_svc_hook_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WORKER = "akt_svc_worker_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const API = "akt_svc_api_cccccccccccccccccccccccccccccccccccccccc";

function logged(env: Record<string, string>): [string, Record<string, unknown>][] {
  const warn = vi.fn();
  logServiceCredentialCheck(workerServiceCredentials(loadSettings({ ...BASE, ...env })), { warn });
  return warn.mock.calls as [string, Record<string, unknown>][];
}

describe("worker service credentials", () => {
  it("reads the three SVC_TOKEN_* values and ignores WEBHOOK_SECRET", () => {
    const s = loadSettings({
      ...BASE,
      SVC_TOKEN_PAPERLESS_HOOK: HOOK,
      SVC_TOKEN_WORKER: WORKER,
      SVC_TOKEN_API: API,
      WEBHOOK_SECRET: "legacy",
    });
    expect(workerServiceCredentials(s)).toEqual({ "paperless-hook": HOOK, worker: WORKER, api: API });
    expect(s).not.toHaveProperty("WEBHOOK_SECRET");
  });

  it("logs every credential as unset for an empty config", () => {
    const events = logged({});
    expect(events).toHaveLength(1);
    expect(events[0]![0]).toBe("service_token_unset");
    expect(events[0]![1].services).toEqual(["paperless-hook", "worker", "api"]);
  });

  it("logs nothing for three distinct strong credentials", () => {
    expect(logged({ SVC_TOKEN_PAPERLESS_HOOK: HOOK, SVC_TOKEN_WORKER: WORKER, SVC_TOKEN_API: API })).toEqual([]);
  });

  it("logs duplicates and weak values without the values", () => {
    const events = logged({ SVC_TOKEN_PAPERLESS_HOOK: "short", SVC_TOKEN_WORKER: API, SVC_TOKEN_API: API });
    expect(events.map(([e]) => e)).toEqual(["service_token_duplicate", "service_token_weak"]);
    expect(events[0]![1].services).toEqual(["worker", "api"]);
    expect(events[1]![1].services).toEqual(["paperless-hook"]);
    const text = JSON.stringify(events);
    expect(text).not.toContain(API);
    expect(text).not.toContain('"short"');
  });
});
