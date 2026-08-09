import { Ollama } from "ollama";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { logger } from "../log.js";
import type { ChatMessage, LLMBackend } from "./base.js";

// How many tokens of JSON output the model is allowed to emit. The Ollama
// server default (around 128 for some models, 2 KB for others) routinely
// truncates DocumentExtraction outputs mid-string when summary_de or the
// confidence_reason field push the body past the limit, surfacing as a
// JSON parse error ("Unterminated string ..."). 4096 is plenty for a
// DocumentExtraction (~1.5 KB of UTF-8) and well within small models'
// typical 8K default context.
const NUM_PREDICT = 4096;

// How many times to retry the chat call on a parse/validation failure.
// Small local models are stochastic — one retry recovers most transient
// truncations. Three attempts in total keeps the worst case bounded.
const MAX_ATTEMPTS = 3;

export class OllamaBackend implements LLMBackend {
  private readonly client: Ollama;
  private readonly modelName: string;

  constructor(baseUrl: string, model = "llama3.1:8b") {
    this.client = new Ollama({ host: baseUrl });
    this.modelName = model;
  }

  get name(): string {
    return "ollama";
  }

  get model(): string {
    return this.modelName;
  }

  async complete<T>(messages: ChatMessage[], responseSchema: z.ZodType<T>): Promise<T> {
    const schemaStr = JSON.stringify(zodToJsonSchema(responseSchema, "response"), null, 2);
    const schemaInstruction =
      "\n\nAntworte ausschließlich mit validem JSON gemäß diesem Schema:\n" + schemaStr;

    const augmented = [...messages];
    for (let i = 0; i < augmented.length; i++) {
      const msg = augmented[i];
      if (msg !== undefined && msg.role === "system") {
        augmented[i] = { role: "system", content: msg.content + schemaInstruction };
        break;
      }
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const response = await this.client.chat({
        model: this.modelName,
        messages: augmented,
        format: "json",
        options: { num_predict: NUM_PREDICT },
        stream: false,
      });

      const raw = cleanJson(response.message.content);
      try {
        return parseWithRecovery(raw, responseSchema, this.modelName);
      } catch (exc) {
        if (!isRecoverableParseError(exc)) throw exc;
        lastError = exc;

        // Try to repair before giving up on this attempt — closes
        // unterminated strings and unbalanced braces. When repair produces
        // a different string and that parses cleanly, return it.
        const repaired = repairTruncatedJson(raw);
        if (repaired !== raw) {
          try {
            const result = parseWithRecovery(repaired, responseSchema, this.modelName);
            logger.warn("ollama_json_repaired", {
              model: this.modelName,
              attempt,
              kind: exc instanceof SyntaxError ? "SyntaxError" : "ZodError",
            });
            return result;
          } catch (inner) {
            if (!isRecoverableParseError(inner)) throw inner;
            lastError = inner;
          }
        }

        if (attempt < MAX_ATTEMPTS - 1) {
          logger.warn("ollama_json_decode_retrying", {
            model: this.modelName,
            attempt,
            error: exc instanceof Error ? exc.message : String(exc),
          });
          continue;
        }
        logger.error("ollama_json_decode_failed", {
          model: this.modelName,
          attempts: MAX_ATTEMPTS,
          error: exc instanceof Error ? exc.message : String(exc),
          raw_tail: raw.slice(-200),
        });
        throw exc;
      }
    }

    // Defensive: the loop above either returns or throws; this branch is
    // only reachable if MAX_ATTEMPTS is 0, which we don't allow.
    throw lastError ?? new Error("ollama complete: exhausted attempts with no captured error");
  }

  async *streamText(messages: ChatMessage[]): AsyncIterable<string> {
    // No format="json" here — this path is intentionally unstructured so
    // the model's natural-language output flows through Paperless tokens
    // rather than getting blocked behind JSON-mode tokenization. The caller
    // is expected to apply any post-hoc parsing (e.g. matching `Dokument N`
    // ids) after the stream completes.
    const stream = await this.client.chat({
      model: this.modelName,
      messages,
      stream: true,
    });
    for await (const chunk of stream) {
      const content = chunk.message?.content ?? "";
      if (content) yield content;
    }
  }
}

function isRecoverableParseError(exc: unknown): boolean {
  return exc instanceof SyntaxError || exc instanceof z.ZodError;
}

/**
 * Parse `raw` into `responseSchema`, attempting key-recovery for models
 * that leak control tokens into JSON keys.
 */
function parseWithRecovery<T>(raw: string, responseSchema: z.ZodType<T>, modelName: string): T {
  const parsed: unknown = JSON.parse(raw); // let SyntaxError bubble, mirrors JSONDecodeError

  const direct = responseSchema.safeParse(parsed);
  if (direct.success) return direct.data;

  // Some local models (notably the gpt-oss/Harmony family) leak control
  // tokens like `<|channel|>` directly into JSON keys, so we end up with
  // `{"answer_<|channel|>{": "…"}` instead of `{"answer_de": "…"}`. Try to
  // rescue once by renaming garbled keys whose prefix matches a canonical
  // schema field, then re-validate. If that still fails, surface the
  // original error.
  const recovered = recoverKeysForSchema(parsed, responseSchema);
  if (recovered === parsed) {
    throw direct.error;
  }
  logger.warn("ollama_json_keys_recovered", {
    model: modelName,
    original_keys: isPlainObject(parsed) ? Object.keys(parsed).sort() : null,
  });
  return responseSchema.parse(recovered);
}

/** Strip YAML document markers and markdown code fences that some models prepend. */
function cleanJson(text: string): string {
  let out = text.trim();
  if (out.startsWith("---")) {
    out = out.replace(/^-+/, "").trim();
  }
  if (out.startsWith("```")) {
    const lines = out.split("\n");
    const body = lines[lines.length - 1]?.trim() === "```" ? lines.slice(1, -1) : lines.slice(1);
    out = body.join("\n");
  }
  return out.trim();
}

/**
 * Best-effort repair for JSON that small models truncated mid-string.
 *
 * Walks the input once, tracking quote/escape/bracket state. If the walk
 * ends inside an unterminated string, we close the string. Then we drop any
 * trailing comma after that, and append closing `]`/`}` for each unclosed
 * bracket. Returns the input unchanged if no repair was needed or if
 * state-walking can't make a safe call.
 *
 * This is a heuristic — it tolerates the common "model ran out of tokens
 * mid-summary" failure but won't fix structurally broken JSON (mismatched
 * braces from earlier, etc.). The caller still validates, so a bad repair
 * surfaces the original error.
 */
export function repairTruncatedJson(text: string): string {
  if (!text) return text;

  let inString = false;
  let escape = false;
  const stack: string[] = []; // holds "{" / "["

  for (const ch of text) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" || ch === "]") {
      const top = stack[stack.length - 1];
      if (top !== undefined && ((top === "{" && ch === "}") || (top === "[" && ch === "]"))) {
        stack.pop();
      } else {
        // structural mismatch — bail out of repair, let the caller fail
        // with the original error so we don't paper over actually-broken
        // output.
        return text;
      }
    }
  }

  if (!inString && stack.length === 0) return text; // already well-formed at the bracket level

  let repaired = text;
  if (inString) repaired += '"';
  // Drop a trailing comma now that the string is closed, so the parser
  // doesn't choke on `…, "field": "value",` after we balance braces.
  repaired = repaired.trimEnd();
  if (repaired.endsWith(",")) repaired = repaired.slice(0, -1);
  for (let i = stack.length - 1; i >= 0; i--) {
    repaired += stack[i] === "{" ? "}" : "]";
  }
  return repaired;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Best-effort rename of garbled top-level keys to canonical schema names.
 *
 * Heuristic: when a canonical schema field is missing AND exactly one
 * sibling key shares the same first underscore-segment as that field (e.g.
 * "answer_de" and "answer_<|channel|>{" both start with "answer"), rename
 * the sibling. Returns a new object on rescue, or the original `parsed`
 * value when nothing can be recovered (so the caller can detect a no-op).
 */
export function recoverKeysForSchema(parsed: unknown, schema: z.ZodType<unknown>): unknown {
  if (!isPlainObject(parsed)) return parsed;
  if (!(schema instanceof z.ZodObject)) return parsed;

  const fields = Object.keys(schema.shape as Record<string, unknown>);
  const out: Record<string, unknown> = { ...parsed };
  let changed = false;

  for (const canonical of fields) {
    if (canonical in out) continue;
    const prefix = canonical.split("_", 1)[0];
    const candidates = Object.keys(out).filter(
      (k) => k !== canonical && k.split("_", 1)[0] === prefix && !fields.includes(k),
    );
    const soleCandidate = candidates.length === 1 ? candidates[0] : undefined;
    if (soleCandidate !== undefined) {
      out[canonical] = out[soleCandidate];
      delete out[soleCandidate];
      changed = true;
    }
  }
  return changed ? out : parsed;
}
