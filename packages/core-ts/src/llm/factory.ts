import { AnthropicBackend } from "./anthropicBackend.js";
import type { LLMBackend } from "./base.js";
import { OllamaBackend } from "./ollamaBackend.js";

export interface CreateBackendOptions {
  anthropicApiKey?: string;
  anthropicModel?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
}

export function createBackend(name: string, options: CreateBackendOptions = {}): LLMBackend {
  const {
    anthropicApiKey,
    anthropicModel = "claude-sonnet-4-6",
    ollamaBaseUrl = "http://localhost:11434",
    ollamaModel = "llama3.1:8b",
  } = options;

  if (name === "anthropic") {
    if (!anthropicApiKey) {
      throw new Error("anthropicApiKey is required when name='anthropic'");
    }
    return new AnthropicBackend(anthropicApiKey, anthropicModel);
  }
  if (name === "ollama") {
    return new OllamaBackend(ollamaBaseUrl, ollamaModel);
  }
  throw new Error(`Unknown LLM backend: ${JSON.stringify(name)}`);
}
