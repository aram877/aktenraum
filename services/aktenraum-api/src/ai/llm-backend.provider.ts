import { createBackend, type LLMBackend } from "@aktenraum/core";
import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";

import { SETTINGS, type Settings } from "../config/settings.js";
import { SettingsService } from "../settings/settings.service.js";

/** `-1` / `0` style numbers go to Ollama as numbers, durations (`30m`) as strings. */
export function parseKeepAlive(raw: string): string | number | undefined {
  const value = raw.trim();
  if (value === "") return undefined;
  return /^-?\d+$/.test(value) ? Number(value) : value;
}

export type BackendRole = "filter" | "answer";

@Injectable()
export class LlmBackendProvider {
  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly settingsService: SettingsService,
  ) {}

  async build(role: BackendRole): Promise<LLMBackend> {
    const backend = this.settings.LLM_BACKEND.toLowerCase();

    if (backend === "anthropic") {
      if (!this.settings.ANTHROPIC_API_KEY) {
        throw new ServiceUnavailableException(
          "LLM backend 'anthropic' selected but ANTHROPIC_API_KEY is unset",
        );
      }
      const model =
        role === "answer" && this.settings.ANTHROPIC_ANSWER_MODEL
          ? this.settings.ANTHROPIC_ANSWER_MODEL
          : this.settings.ANTHROPIC_MODEL;
      return createBackend("anthropic", {
        anthropicApiKey: this.settings.ANTHROPIC_API_KEY,
        anthropicModel: model,
      });
    }

    if (backend === "ollama") {
      let model: string;
      if (role === "answer" && this.settings.OLLAMA_ANSWER_MODEL) {
        model = this.settings.OLLAMA_ANSWER_MODEL;
      } else if (role === "answer") {
        model = await this.settingsService.getActiveAnswerModel();
      } else {
        model = await this.settingsService.getActiveModel();
      }
      const answer = role === "answer";
      return createBackend("ollama", {
        ollamaBaseUrl: this.settings.OLLAMA_BASE_URL,
        ollamaModel: model,
        ...(answer
          ? {
              ollamaNumCtx: this.settings.OLLAMA_ANSWER_NUM_CTX || this.settings.OLLAMA_NUM_CTX,
              ollamaKeepAlive: parseKeepAlive(this.settings.OLLAMA_KEEP_ALIVE),
            }
          : {}),
      });
    }

    throw new ServiceUnavailableException(
      `Unknown LLM backend: ${JSON.stringify(this.settings.LLM_BACKEND)}`,
    );
  }
}
