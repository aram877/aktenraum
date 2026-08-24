import { describe, expect, it } from "vitest";
import { DEFAULT_RERANKER_MODEL, LocalReranker, type RerankCandidate } from "./reranker.js";

// Adapted from services/auto-tagger/tests/test_rag_reranker.py. The Python
// version stubs sentence-transformers' single `CrossEncoder.predict(pairs)`
// call; this port's real dependency (transformers.js) is a two-step
// tokenizer + classifier API (see the spike notes in tasks.md section 1),
// so the stub here mirrors *that* shape instead — same test intent, same
// coverage, different fake shape to match the real one being wrapped.

interface RecordedCall {
  queries: string[];
  textPairs: string[];
}

function fakeTokenizerAndClassifier(scores: number[]) {
  const calls: RecordedCall[] = [];
  const tokenizer = async (
    queries: string[],
    options: { text_pair: string[] },
  ): Promise<unknown> => {
    calls.push({ queries, textPairs: options.text_pair });
    return { textPairs: options.text_pair };
  };
  const classifier = async (inputs: unknown): Promise<{ logits: { data: number[] } }> => {
    const { textPairs } = inputs as { textPairs: string[] };
    return { logits: { data: scores.slice(0, textPairs.length) } };
  };
  return { tokenizer, classifier, calls };
}

function candidates(texts: string[]): RerankCandidate[] {
  // ids mirror order so assertions read at a glance.
  return texts.map((t, i) => ({ id: String(i), text: t }));
}

describe("LocalReranker.rerank — happy path", () => {
  it("orders results by descending score", async () => {
    // Cross-encoder returns higher score = more relevant. Wrapper sorts so
    // the most-relevant candidate is first in the output.
    const { tokenizer, classifier } = fakeTokenizerAndClassifier([0.1, 0.9, 0.5]);
    const reranker = new LocalReranker(undefined, { tokenizer, classifier });

    const out = await reranker.rerank("frage", candidates(["wenig relevant", "sehr relevant", "mittel"]));

    expect(out.map((r) => r.id)).toEqual(["1", "2", "0"]);
    expect(out[0]!.score).toBe(0.9);
  });

  it("truncates to topK after sorting, not a pre-sort prefix", async () => {
    const { tokenizer, classifier } = fakeTokenizerAndClassifier([0.1, 0.9, 0.5, 0.3, 0.7]);
    const reranker = new LocalReranker(undefined, { tokenizer, classifier });

    const out = await reranker.rerank("frage", candidates(["a", "b", "c", "d", "e"]), {
      topK: 2,
    });

    expect(out.length).toBe(2);
    expect(out.map((r) => r.id)).toEqual(["1", "4"]); // 0.9 then 0.7
  });

  it("returns all candidates when topK is omitted", async () => {
    const { tokenizer, classifier } = fakeTokenizerAndClassifier([0.5, 0.5, 0.5]);
    const reranker = new LocalReranker(undefined, { tokenizer, classifier });

    const out = await reranker.rerank("q", candidates(["a", "b", "c"]));
    expect(out.length).toBe(3);
  });

  it("returns all candidates when topK exceeds the input size", async () => {
    const { tokenizer, classifier } = fakeTokenizerAndClassifier([0.5]);
    const reranker = new LocalReranker(undefined, { tokenizer, classifier });

    const out = await reranker.rerank("q", candidates(["only"]), { topK: 99 });
    expect(out.length).toBe(1);
  });
});

describe("LocalReranker.rerank — empty input", () => {
  it("short-circuits without a model call", async () => {
    // No upstream call when candidates is empty — saves model load cost in
    // code paths where the retrieval step might find nothing.
    const { tokenizer, classifier, calls } = fakeTokenizerAndClassifier([]);
    const reranker = new LocalReranker(undefined, { tokenizer, classifier });

    const out = await reranker.rerank("q", []);
    expect(out).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("LocalReranker.rerank — pair shape", () => {
  it("pairs the query with every candidate text, in order", async () => {
    // Cross-encoders score (query, document) pairs jointly. The wrapper
    // must wire the same query into every pair, in the same order as the
    // candidates.
    const { tokenizer, classifier, calls } = fakeTokenizerAndClassifier([0.1, 0.2]);
    const reranker = new LocalReranker(undefined, { tokenizer, classifier });

    await reranker.rerank("die frage", candidates(["doc a", "doc b"]));

    expect(calls).toEqual([
      { queries: ["die frage", "die frage"], textPairs: ["doc a", "doc b"] },
    ]);
  });

  it("passes candidate ids through verbatim", async () => {
    // Reranker doesn't synthesise ids — whatever the caller put in
    // RerankCandidate.id comes back verbatim.
    const { tokenizer, classifier } = fakeTokenizerAndClassifier([0.5, 0.6]);
    const reranker = new LocalReranker(undefined, { tokenizer, classifier });

    const out = await reranker.rerank("q", [
      { id: "qdrant-uuid-1", text: "x" },
      { id: "qdrant-uuid-2", text: "y" },
    ]);
    expect(new Set(out.map((r) => r.id))).toEqual(new Set(["qdrant-uuid-1", "qdrant-uuid-2"]));
  });
});

describe("LocalReranker — model + name properties", () => {
  it("has a default model pinned to the ONNX-community bge-reranker-v2-m3 export", () => {
    // NOTE: this deliberately differs from the Python side's
    // `DEFAULT_RERANKER_MODEL == "BAAI/bge-reranker-v2-m3"` — that's the
    // original sentence-transformers model id, which transformers.js
    // cannot load directly. This port targets its ONNX-converted sibling
    // repo instead (same weights). See tasks.md 3.7 / the module docstring.
    const reranker = new LocalReranker(undefined, { tokenizer: async () => ({}), classifier: async () => ({ logits: { data: [] } }) });
    expect(DEFAULT_RERANKER_MODEL).toBe("onnx-community/bge-reranker-v2-m3-ONNX");
    expect(reranker.model).toBe(DEFAULT_RERANKER_MODEL);
  });

  it("supports overriding the model name", () => {
    const reranker = new LocalReranker("onnx-community/bge-reranker-base-ONNX", {
      tokenizer: async () => ({}),
      classifier: async () => ({ logits: { data: [] } }),
    });
    expect(reranker.model).toBe("onnx-community/bge-reranker-base-ONNX");
  });

  it("reports its backend name as transformers-js", () => {
    const reranker = new LocalReranker(undefined, {
      tokenizer: async () => ({}),
      classifier: async () => ({ logits: { data: [] } }),
    });
    expect(reranker.name).toBe("transformers-js");
  });
});

describe("LocalReranker.rerank — output shape", () => {
  it("returns frozen results (rerank output is passed by reference downstream)", async () => {
    const { tokenizer, classifier } = fakeTokenizerAndClassifier([0.5]);
    const reranker = new LocalReranker(undefined, { tokenizer, classifier });

    const [result] = await reranker.rerank("q", candidates(["a"]));
    expect(() => {
      // @ts-expect-error — intentionally mutating a frozen object for the test
      result!.score = 0.9;
    }).toThrow();
  });

  it("coerces scores to plain numbers", async () => {
    // Mirrors the Python side's numpy-scalar-to-float coercion concern:
    // whatever numeric type the model output uses, callers get plain
    // JS numbers so the shape is JSON-serialisable without adapters.
    const { tokenizer, classifier } = fakeTokenizerAndClassifier([0.7, 0.3]);
    const reranker = new LocalReranker(undefined, { tokenizer, classifier });

    const out = await reranker.rerank("q", candidates(["a", "b"]));
    expect(out.every((r) => typeof r.score === "number")).toBe(true);
  });
});
