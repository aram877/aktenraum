/**
 * Cross-encoder reranker for the RAG retrieval pipeline.
 *
 * After dense vector search returns top-K candidates by cosine similarity,
 * a cross-encoder reranker re-scores each (query, candidate) pair by
 * running them jointly through a transformer that has access to BOTH sides
 * of the comparison.
 *
 * Model: `onnx-community/bge-reranker-v2-m3-ONNX`, the transformers.js-ready
 * ONNX export of `BAAI/bge-reranker-v2-m3` (the model id the Python side
 * loads via sentence-transformers' `CrossEncoder` — same weights,
 * ONNX-converted). Loaded via `@huggingface/transformers`
 * (`AutoTokenizer`/`AutoModelForSequenceClassification`), CPU-only,
 * `dtype: "q8"` — see openspec/changes/rewrite-stack-nodejs-angular/tasks.md
 * section 1 for why: the default fp32 export uses ONNX's external-data
 * format and the library doesn't auto-fetch the sibling weights file, and
 * the high-level `pipeline("text-classification", ...)` helper doesn't
 * support cross-encoder pair input at all. The q8 quantized, self-contained
 * export benchmarked at ~11-19ms/candidate on CPU, beating the ~50ms/pair
 * Python fp32 baseline.
 */
import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import { logger } from "../log.js";

// Pinned default. Swappable at construction.
export const DEFAULT_RERANKER_MODEL = "onnx-community/bge-reranker-v2-m3-ONNX";

/**
 * One candidate going into the reranker. `id` is opaque to the reranker —
 * a pure passthrough so the caller can stitch rerank scores back to
 * whatever shape it stores candidates in (Qdrant SearchHit, etc.).
 */
export interface RerankCandidate {
  readonly id: string;
  readonly text: string;
}

/**
 * One reranked result. `score` is the raw cross-encoder logit; it is NOT a
 * probability or normalized to [0, 1]. Callers should treat it as an
 * ordering signal only — comparing scores across different reranker models
 * is meaningless.
 */
export interface RerankResult {
  readonly id: string;
  readonly score: number;
}

/**
 * Pluggable reranker backend. `model`/`name` mirror the Embedder interface
 * so observability code can treat all RAG components uniformly.
 */
export interface Reranker {
  readonly name: string;
  readonly model: string;
  rerank(
    query: string,
    candidates: readonly RerankCandidate[],
    options?: { topK?: number },
  ): Promise<RerankResult[]>;
}

interface TokenizerLike {
  (
    queries: string[],
    options: { text_pair: string[]; padding: boolean; truncation: boolean },
  ): Promise<unknown> | unknown;
}

interface ClassifierLike {
  (inputs: unknown): Promise<{ logits: { data: ArrayLike<number> } }>;
}

/**
 * transformers.js-backed cross-encoder, wrapped for our async API.
 *
 * Model is loaded lazily on the first `rerank` call: test environments can
 * construct a `LocalReranker` without paying the model load on every test
 * file, and the ~570 MB quantized download from Hugging Face happens on
 * first use rather than at process start.
 */
export class LocalReranker implements Reranker {
  private readonly modelName: string;
  private tokenizer: TokenizerLike | null;
  private classifier: ClassifierLike | null;
  private loadPromise: Promise<{ tokenizer: TokenizerLike; classifier: ClassifierLike }> | null =
    null;

  constructor(
    modelName: string = DEFAULT_RERANKER_MODEL,
    options: { tokenizer?: TokenizerLike; classifier?: ClassifierLike } = {},
  ) {
    this.modelName = modelName;
    // Allow tests to inject a stub directly. In production these are null
    // at construction; the real tokenizer/classifier load in ensureLoaded
    // on first call.
    this.tokenizer = options.tokenizer ?? null;
    this.classifier = options.classifier ?? null;
  }

  get name(): string {
    return "transformers-js";
  }

  get model(): string {
    return this.modelName;
  }

  /** Lazy-load the tokenizer + cross-encoder, deduped across concurrent callers. */
  private async ensureLoaded(): Promise<{ tokenizer: TokenizerLike; classifier: ClassifierLike }> {
    if (this.tokenizer && this.classifier) {
      return { tokenizer: this.tokenizer, classifier: this.classifier };
    }
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      logger.info("reranker_loading_model", { model: this.modelName });
      const tokenizer = (await AutoTokenizer.from_pretrained(this.modelName)) as TokenizerLike;
      const classifier = (await AutoModelForSequenceClassification.from_pretrained(
        this.modelName,
        { dtype: "q8" },
      )) as ClassifierLike;
      this.tokenizer = tokenizer;
      this.classifier = classifier;
      logger.info("reranker_model_loaded", { model: this.modelName });
      return { tokenizer, classifier };
    })();
    return this.loadPromise;
  }

  /**
   * Re-score every (query, candidate.text) pair, return them sorted by
   * descending score. `topK` truncates after sorting; omitting it returns
   * all candidates so the caller can decide.
   *
   * Empty candidates -> empty result, no upstream call.
   */
  async rerank(
    query: string,
    candidates: readonly RerankCandidate[],
    options: { topK?: number } = {},
  ): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];
    const { tokenizer, classifier } = await this.ensureLoaded();

    const inputs = await tokenizer(
      candidates.map(() => query),
      {
        text_pair: candidates.map((c) => c.text),
        padding: true,
        truncation: true,
      },
    );
    const { logits } = await classifier(inputs);
    const scores = Array.from(logits.data);

    const ranked: RerankResult[] = candidates.map((c, i) =>
      Object.freeze({ id: c.id, score: Number(scores[i]) }),
    );
    ranked.sort((a, b) => b.score - a.score);
    return options.topK !== undefined ? ranked.slice(0, options.topK) : ranked;
  }
}
