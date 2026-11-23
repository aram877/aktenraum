import { Ollama } from "ollama";

/**
 * Dense vector dimension of the configured embedding model
 * (Qwen3-Embedding-4B -> 2560). The Qdrant collection is created against
 * this value, so it is the single source of truth: QdrantVectorStore
 * imports it as its default denseDim. Switching to a model with a
 * different dimension requires deleting and recreating the collection
 * (vectors of different dims can't coexist) plus a full re-index — keep
 * this in lockstep with the model named in EMBEDDING_MODEL / the
 * OllamaEmbedder default below.
 */
export const DENSE_DIM = 2560;

/**
 * Pluggable embedding backend used by the indexing and query paths. Today
 * only embedDense is required. When sparse-vector support lands, extend
 * this with embedSparse(texts) -> Record<number, number>[] (a SPLADE-like
 * sparse vector is a {tokenId: weight} map).
 */
export interface Embedder {
  readonly model: string;
  readonly denseDim: number;
  embedDense(texts: string[]): Promise<number[][]>;
}

/**
 * Ollama-backed dense embedder targeting `qwen3-embedding:4b` by default.
 * Wraps Ollama's `/api/embed` for batched dense embeddings. Ollama
 * internally batches the input list in a single inference pass, so we
 * don't add a client-side mini-batching loop — feeding the whole batch
 * through is faster than splitting it.
 */
/**
 * Context window requested for every embedding call, by the worker (chunks, ~550 tokens) and the api
 * (questions) alike. Ollama loads the embedding model with its full 32k window otherwise (~8 GB for
 * qwen3-embedding:4b instead of ~3 GB), which pushes the answer model out of VRAM. Worker and api
 * must agree on the value: a differing `num_ctx` makes Ollama reload the model.
 */
export const EMBED_NUM_CTX = 4096;

export class OllamaEmbedder implements Embedder {
  private readonly client: Ollama;
  private readonly modelName: string;
  private readonly keepAlive: string | number | undefined;

  constructor(
    baseUrl: string,
    model = "qwen3-embedding:4b",
    client?: Ollama,
    keepAlive?: string | number,
  ) {
    this.client = client ?? new Ollama({ host: baseUrl });
    this.modelName = model;
    this.keepAlive = keepAlive;
  }

  get model(): string {
    return this.modelName;
  }

  get denseDim(): number {
    return DENSE_DIM;
  }

  /**
   * Embed a batch of texts. Returns one dense vector per input in the same
   * order. Empty input -> empty output (no upstream call).
   *
   * Throws whatever the Ollama client throws on transport/5xx errors; the
   * caller (indexing worker) is expected to retry or surface as an
   * `ai-index-error` lifecycle tag. We deliberately don't catch here —
   * silently swallowing embedding failures would produce a doc that's
   * "indexed" but invisible to search.
   */
  async embedDense(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.client.embed({
      model: this.modelName,
      input: texts,
      options: { num_ctx: EMBED_NUM_CTX },
      ...(this.keepAlive !== undefined ? { keep_alive: this.keepAlive } : {}),
    });
    return response.embeddings.map((vec) => [...vec]);
  }
}
