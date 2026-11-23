import { Ollama } from "ollama";
import { describe, expect, it } from "vitest";

import { EMBED_NUM_CTX, OllamaEmbedder } from "./embedder.js";

function embedderWith(keepAlive?: string | number) {
  const bodies: Record<string, unknown>[] = [];
  const fetchFn = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
    return new Response(JSON.stringify({ model: "m", embeddings: [[0.1, 0.2]] }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new Ollama({ host: "http://x", fetch: fetchFn });
  return { bodies, embedder: new OllamaEmbedder("http://x", "m", client, keepAlive) };
}

describe("OllamaEmbedder request", () => {
  it("bounds the context and sends keep_alive when set", async () => {
    const { bodies, embedder } = embedderWith(-1);
    await embedder.embedDense(["hallo"]);
    expect(bodies[0]?.keep_alive).toBe(-1);
    expect((bodies[0]?.options as Record<string, unknown>).num_ctx).toBe(EMBED_NUM_CTX);
  });

  it("omits keep_alive when unset", async () => {
    const { bodies, embedder } = embedderWith();
    await embedder.embedDense(["hallo"]);
    expect(bodies[0]).not.toHaveProperty("keep_alive");
  });

  it("makes no request for an empty batch", async () => {
    const { bodies, embedder } = embedderWith();
    expect(await embedder.embedDense([])).toEqual([]);
    expect(bodies).toEqual([]);
  });
});
