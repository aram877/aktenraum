import { z } from "zod";

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      if (raw === undefined || raw.trim() === "") return fallback;
      return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
    });

const int = (fallback: number, min?: number, max?: number) =>
  z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === "") return fallback;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be an integer" });
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
  z
    .string({ required_error: `${name} is required` })
    .min(1, `${name} must not be empty`);

export const settingsSchema = z.object({
  DATABASE_URL: required("DATABASE_URL"),
  JWT_SECRET: required("JWT_SECRET"),
  JWT_EXPIRES_SECONDS: int(28800, 60),

  COOKIE_NAME: str("aktenraum_session"),
  COOKIE_SECURE: bool(true),

  BOOTSTRAP_USERNAME: str(""),
  BOOTSTRAP_PASSWORD: str(""),

  LOG_LEVEL: str("INFO"),
  PORT: int(8002, 1, 65535),

  PAPERLESS_BASE_URL: str("http://paperless:8000"),
  PAPERLESS_API_TOKEN: str(""),
  CORRESPONDENT_LIST_TTL_SECONDS: int(300, 1),

  UPLOAD_MAX_FILE_BYTES: int(25 * 1024 * 1024, 1),
  UPLOAD_MAX_FILES_PER_REQUEST: int(20, 1),

  AUTO_TAGGER_URL: str("http://auto-tagger:8001"),
  WEBHOOK_SECRET: str(""),

  LLM_BACKEND: z
    .enum(["anthropic", "ollama"])
    .optional()
    .transform((raw) => raw ?? "anthropic"),
  ANTHROPIC_API_KEY: str(""),
  ANTHROPIC_MODEL: str("claude-sonnet-4-6"),
  ANTHROPIC_ANSWER_MODEL: str(""),
  OLLAMA_BASE_URL: str("http://host.docker.internal:11434"),
  OLLAMA_MODEL: str("llama3.1:8b"),
  OLLAMA_ANSWER_MODEL: str(""),

  QDRANT_URL: str(""),
  EMBEDDING_MODEL: str("qwen3-embedding:4b"),
  RERANKER_MODEL: str("onnx-community/bge-reranker-v2-m3-ONNX"),
  RAG_RETRIEVAL_TOP_K: int(50, 1, 200),
  RAG_RERANK_TOP_K: int(5, 1, 50),
});

export type Settings = z.infer<typeof settingsSchema>;

export const SETTINGS = Symbol("AKTENRAUM_SETTINGS");

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
