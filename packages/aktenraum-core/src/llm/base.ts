import type { z } from "zod";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

// Mirrors aktenraum_core.llm.base.LLMBackend (a Python Protocol).
export interface LLMBackend {
  readonly name: string;
  readonly model: string;

  complete<T>(messages: ChatMessage[], responseSchema: z.ZodType<T>): Promise<T>;

  /**
   * Stream a free-form prose response as text deltas. No JSON/schema
   * constraint — callers that need structured output should use `complete`.
   * Yields zero or more non-empty text chunks in the order the model emits
   * them.
   */
  streamText(messages: ChatMessage[]): AsyncIterable<string>;
}
