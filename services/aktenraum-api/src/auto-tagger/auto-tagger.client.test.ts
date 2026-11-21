import { afterEach, describe, expect, it, vi } from "vitest";

import { loadSettings } from "../config/settings.js";
import { TEST_API_TOKEN, TEST_ENV } from "../test/harness.js";
import { AutoTaggerClient } from "./auto-tagger.client.js";

function client(env: Record<string, string> = {}): AutoTaggerClient {
  return new AutoTaggerClient(
    loadSettings({ ...TEST_ENV, AUTO_TAGGER_URL: "http://auto-tagger:8001/", SVC_TOKEN_API: TEST_API_TOKEN, ...env }),
  );
}

function stubFetch(body: unknown = {}) {
  const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(body));
  vi.stubGlobal("fetch", fetchFn);
  return fetchFn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AutoTaggerClient", () => {
  it("sends the api credential on triggers, never X-Aktenraum-Secret", async () => {
    const fetchFn = stubFetch();
    expect(await client().ping(7, { trigger: "propagate" })).toBe(true);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("http://auto-tagger:8001/trigger/propagate");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TEST_API_TOKEN}`);
    expect(headers).not.toHaveProperty("X-Aktenraum-Secret");
  });

  it("sends the api credential when reading /processing", async () => {
    const fetchFn = stubFetch({ processing: [3] });
    expect(await client().fetchProcessingState()).toEqual({ processing: [3] });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("http://auto-tagger:8001/processing");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_API_TOKEN}`);
  });

  it("sends no Authorization header when SVC_TOKEN_API is unset", async () => {
    const fetchFn = stubFetch();
    await client({ SVC_TOKEN_API: "" }).ping(7, { trigger: "extract" });
    expect(fetchFn.mock.calls[0]![1]?.headers).not.toHaveProperty("Authorization");
  });
});
