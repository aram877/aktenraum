import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ChatMessage, LLMBackend } from "./base.js";

const STREAM_MAX_TOKENS = 1024;
const COMPLETE_MAX_TOKENS = 4096;

export class AnthropicBackend implements LLMBackend {
  private readonly client: Anthropic;
  private readonly modelName: string;

  constructor(apiKey: string, model = "claude-sonnet-4-6") {
    this.client = new Anthropic({ apiKey });
    this.modelName = model;
  }

  get name(): string {
    return "anthropic";
  }

  get model(): string {
    return this.modelName;
  }

  async complete<T>(messages: ChatMessage[], responseSchema: z.ZodType<T>): Promise<T> {
    const schema = zodToJsonSchema(responseSchema, "extract_document_schema");
    const toolDef: Anthropic.Tool = {
      name: "extract_document",
      description: "Extrahiert strukturierte Metadaten aus dem Dokument.",
      input_schema: schema as unknown as Anthropic.Tool.InputSchema,
    };

    const { system, rest } = splitSystem(messages);
    const response = await this.client.messages.create({
      model: this.modelName,
      max_tokens: COMPLETE_MAX_TOKENS,
      tools: [toolDef],
      tool_choice: { type: "tool", name: "extract_document" },
      messages: rest as Anthropic.MessageParam[],
      ...(system ? { system } : {}),
    });

    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "extract_document") {
        return responseSchema.parse(block.input);
      }
    }
    throw new Error("Anthropic response contained no tool_use block");
  }

  async *streamText(messages: ChatMessage[]): AsyncIterable<string> {
    // Splits a system message off the front (Anthropic takes `system` as a
    // top-level param, not a role) so callers can keep using the
    // OpenAI-style message list shape end-to-end.
    const { system, rest } = splitSystem(messages);
    const stream = this.client.messages.stream({
      model: this.modelName,
      max_tokens: STREAM_MAX_TOKENS,
      messages: rest as Anthropic.MessageParam[],
      ...(system ? { system } : {}),
    });
    // No `.textStream` convenience iterator on this SDK version — consume
    // the raw event stream and pull text deltas out ourselves.
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        if (event.delta.text) yield event.delta.text;
      }
    }
  }
}

/**
 * Pull the first system message out; return it plus the rest verbatim.
 * Anthropic rejects `role: "system"` inside the messages array — system
 * prompts must travel as the top-level `system` param. The OpenAI-style
 * callers in this codebase put the prompt as a system role, so this adapter
 * normalises that shape.
 */
export function splitSystem(messages: ChatMessage[]): { system: string | null; rest: ChatMessage[] } {
  let system: string | null = null;
  const rest: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "system" && system === null) {
      system = msg.content;
      continue;
    }
    rest.push(msg);
  }
  return { system, rest };
}
