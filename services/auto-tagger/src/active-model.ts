import { logger } from "@aktenraum/core";

const CACHE_TTL_SECONDS = 60;

export class ActiveModelConfig {
  private cache: string | null = null;
  private loadedAt = 0;
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly apiUrl: string,
    private readonly webhookSecret: string,
    private readonly fallbackModel: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async getModel(now: number = Date.now() / 1000): Promise<string> {
    if (this.cache !== null && now - this.loadedAt <= CACHE_TTL_SECONDS) return this.cache;
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.load(now).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async load(now: number): Promise<string> {
    if (!this.apiUrl) return this.fallback("api_url_unset");
    const headers: Record<string, string> = {};
    if (this.webhookSecret) headers["X-Aktenraum-Secret"] = this.webhookSecret;
    const url = `${this.apiUrl.replace(/\/+$/, "")}/api/settings/active-llm-model`;
    try {
      const resp = await this.fetchFn(url, { headers, signal: AbortSignal.timeout(5_000) });
      if (!resp.ok) return this.fallback(`status_${resp.status}`);
      const payload = (await resp.json()) as { ollama_model?: unknown };
      const model = typeof payload.ollama_model === "string" ? payload.ollama_model.trim() : "";
      if (!model) return this.fallback("empty_model");
      if (model !== this.cache) logger.info("active_llm_model_resolved", { model });
      this.cache = model;
      this.loadedAt = now;
      return model;
    } catch (error: unknown) {
      return this.fallback(error instanceof Error ? error.message : String(error));
    }
  }

  private fallback(reason: string): string {
    if (this.cache !== null) {
      logger.warn("active_llm_model_unreachable_using_cache", { reason, model: this.cache });
      return this.cache;
    }
    logger.warn("active_llm_model_unreachable_using_env", { reason, model: this.fallbackModel });
    return this.fallbackModel;
  }
}
