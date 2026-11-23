import { describe, expect, it } from "vitest";

import { loadSettings } from "../config/settings.js";
import { TEST_ENV } from "../test/harness.js";
import { LlmBackendProvider, parseKeepAlive } from "./llm-backend.provider.js";

function provider(env: Record<string, string>): LlmBackendProvider {
  const settings = loadSettings({ ...TEST_ENV, LLM_BACKEND: "ollama", ...env });
  const settingsService = {
    getActiveModel: async () => "extract:1",
    getActiveAnswerModel: async () => "answer:1",
  };
  return new LlmBackendProvider(settings, settingsService as never);
}

/** The private numCtx / keepAlive of the built OllamaBackend. */
async function options(env: Record<string, string>, role: "filter" | "answer") {
  const backend = (await provider(env).build(role)) as unknown as {
    numCtx?: number;
    keepAlive?: string | number;
  };
  return { numCtx: backend.numCtx, keepAlive: backend.keepAlive };
}

describe("parseKeepAlive", () => {
  it("turns integers into numbers and keeps durations as strings", () => {
    expect(parseKeepAlive("-1")).toBe(-1);
    expect(parseKeepAlive("0")).toBe(0);
    expect(parseKeepAlive("30m")).toBe("30m");
    expect(parseKeepAlive("  ")).toBeUndefined();
  });
});

describe("answer backend options", () => {
  it("leaves keep-alive to Ollama's default and uses the extraction context size", async () => {
    expect(await options({}, "answer")).toEqual({ numCtx: 24576, keepAlive: undefined });
  });

  it("honours OLLAMA_NUM_CTX when no answer-specific size is set", async () => {
    expect((await options({ OLLAMA_NUM_CTX: "16384" }, "answer")).numCtx).toBe(16384);
  });

  it("lets OLLAMA_ANSWER_NUM_CTX and OLLAMA_KEEP_ALIVE override", async () => {
    expect(
      await options({ OLLAMA_ANSWER_NUM_CTX: "8192", OLLAMA_KEEP_ALIVE: "30m" }, "answer"),
    ).toEqual({ numCtx: 8192, keepAlive: "30m" });
  });

  it("leaves the filter backend untouched", async () => {
    expect(await options({}, "filter")).toEqual({ numCtx: undefined, keepAlive: undefined });
  });
});
