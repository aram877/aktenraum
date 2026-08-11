import { z } from "zod";

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((raw) =>
      raw === undefined || raw.trim() === ""
        ? fallback
        : ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase()),
    );

const num = (fallback: number, min?: number, max?: number) =>
  z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === "") return fallback;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a number" });
        return z.NEVER;
      }
      if (min !== undefined && parsed < min) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be >= ${min}` });
        return z.NEVER;
      }
      if (max !== undefined && parsed > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be <= ${max}` });
        return z.NEVER;
      }
      return parsed;
    });

const str = (fallback = "") =>
  z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw === "" ? fallback : raw));

const required = (name: string) =>
  z.string({ required_error: `${name} is required` }).min(1, `${name} must not be empty`);

export const settingsSchema = z.object({
  PAPERLESS_BASE_URL: required("PAPERLESS_BASE_URL"),
  PAPERLESS_API_TOKEN: required("PAPERLESS_API_TOKEN"),

  LLM_BACKEND: z
    .enum(["anthropic", "ollama"])
    .optional()
    .transform((raw) => raw ?? "anthropic"),
  ANTHROPIC_API_KEY: str(""),
  ANTHROPIC_MODEL: str("claude-sonnet-4-6"),
  OLLAMA_BASE_URL: str("http://localhost:11434"),
  OLLAMA_MODEL: str("llama3.1:8b"),

  POLL_INTERVAL_SECONDS: num(30, 5),
  BATCH_SIZE: num(5, 1),
  ENABLE_PROPAGATION: bool(true),
  LOW_CONFIDENCE_THRESHOLD: num(0.6, 0, 1),
  FEW_SHOT_EXAMPLES: num(0, 0, 5),
  USE_CORRESPONDENT_HISTORY: bool(true),
  MAX_TOKENS_INPUT: num(12000, 1000),

  ENABLE_HTTP_SERVER: bool(true),
  HTTP_PORT: num(8001, 1, 65535),
  WEBHOOK_SECRET: str(""),

  AKTENRAUM_API_URL: str("http://aktenraum-api:8002"),
  QDRANT_URL: str(""),
  EMBEDDING_MODEL: str("qwen3-embedding:4b"),
  LOG_LEVEL: str("INFO"),
});

export type Settings = z.infer<typeof settingsSchema>;

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const parsed = settingsSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration — ${detail}`);
  }
  return parsed.data;
}
