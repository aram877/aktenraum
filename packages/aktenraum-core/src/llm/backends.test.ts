import { describe, expect, it } from "vitest";

import { splitSystem } from "./anthropicBackend.js";
import { fetchWithTimeout } from "./ollamaBackend.js";

describe("splitSystem", () => {
  it("lifts the system message out of the message list", () => {
    expect(
      splitSystem([
        { role: "system", content: "S" },
        { role: "user", content: "U" },
      ]),
    ).toEqual({ system: "S", rest: [{ role: "user", content: "U" }] });
  });
});

describe("fetchWithTimeout", () => {
  const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as typeof fetch;

  it("aborts a request that outlives the timeout", async () => {
    await expect(fetchWithTimeout(20, hanging)("http://x")).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("still honours the caller's own abort signal", async () => {
    const controller = new AbortController();
    const pending = fetchWithTimeout(10_000, hanging)("http://x", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
