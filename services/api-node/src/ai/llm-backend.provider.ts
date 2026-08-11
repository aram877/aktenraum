import { createBackend, type LLMBackend } from "@aktenraum/core-ts";
import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";

import { SETTINGS, type Settings } from "../config/settings.js";
import { SettingsService } from "../settings/settings.service.js";

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
      return createBackend("ollama", {
        ollamaBaseUrl: this.settings.OLLAMA_BASE_URL,
        ollamaModel: model,
      });
    }

    throw new ServiceUnavailableException(
      `Unknown LLM backend: ${JSON.stringify(this.settings.LLM_BACKEND)}`,
    );
  }
}
