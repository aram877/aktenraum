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

/** A comma list; blank entries dropped, fallback when unset or empty. */
const list = (fallback: string[]) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      const items = (raw ?? "").split(",").map((item) => item.trim()).filter((item) => item !== "");
      return items.length > 0 ? items : fallback;
    });

const required = (name: string) =>
  z
    .string({ required_error: `${name} is required` })
    .min(1, `${name} must not be empty`);

/** A required base64 secret that must decode to exactly `bytes` bytes. */
const base64Key = (name: string, bytes: number) =>
  required(name).refine((raw) => Buffer.from(raw, "base64").length === bytes, {
    message: `${name} must be ${bytes} random bytes, base64-encoded (openssl rand -base64 ${bytes})`,
  });

export const settingsSchema = z.object({
  DATABASE_URL: required("DATABASE_URL"),
  // Encrypts the members' Paperless API tokens at rest (ADR-010 §8). Tokens
  // are re-mintable, so a lost or changed key costs nothing but a re-mint.
  AKTENRAUM_SECRET_KEY: base64Key("AKTENRAUM_SECRET_KEY", 32),
  // Browser sessions (auth-server-sessions): expire after SESSION_IDLE_DAYS
  // without use, and SESSION_ABSOLUTE_DAYS after login in any case.
  SESSION_IDLE_DAYS: int(7, 1, 365),
  SESSION_ABSOLUTE_DAYS: int(30, 1, 365),

  COOKIE_NAME: str("aktenraum_session"),
  COOKIE_SECURE: bool(true),

  // Passkeys (auth-passkeys): the origins a WebAuthn ceremony may come from
  // and the relying-party IDs passkeys are bound to. Every origin's hostname
  // must be one of the RP IDs; IP addresses are refused (browsers refuse them).
  WEBAUTHN_ORIGINS: list(["http://localhost:8080", "http://localhost:4300"]),
  WEBAUTHN_RP_IDS: list(["localhost"]),

  BOOTSTRAP_USERNAME: str(""),
  BOOTSTRAP_PASSWORD: str(""),

  LOG_LEVEL: str("INFO"),
  PORT: int(8002, 1, 65535),

  PAPERLESS_BASE_URL: str("http://paperless:8000"),
  PAPERLESS_API_TOKEN: str(""),
  CORRESPONDENT_LIST_TTL_SECONDS: int(300, 1),

  UPLOAD_MAX_FILE_BYTES: int(25 * 1024 * 1024, 1),
  UPLOAD_MAX_FILES_PER_REQUEST: int(20, 1),

  BACKUP_STATUS_FILE: str("/run/backup-status/backup-status.json"),

  AUTO_TAGGER_URL: str("http://auto-tagger:8001"),
  // Service credentials (ADR-010 step 5): the worker's, verified on internal
  // routes, and the api's own, sent to the worker. WEBHOOK_SECRET is retired.
  SVC_TOKEN_WORKER: str(""),
  SVC_TOKEN_API: str(""),

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
  QDRANT_API_KEY: str(""),
  EMBEDDING_MODEL: str("qwen3-embedding:4b"),
  RERANKER_MODEL: str("onnx-community/bge-reranker-v2-m3-ONNX"),
  /** Test / low-memory switch: false = no reranker model, retrieval keeps Qdrant's order. */
  RERANKER_ENABLED: bool(true),
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
  const webauthnProblems = webauthnConfigProblems(parsed.data.WEBAUTHN_ORIGINS, parsed.data.WEBAUTHN_RP_IDS);
  if (webauthnProblems.length > 0) {
    throw new Error(`Invalid configuration — ${webauthnProblems.join("; ")}`);
  }
  return parsed.data;
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");
}

/**
 * Startup validation of the passkey addresses (design §3): origins parse as
 * http(s) URLs without a path, their hostname is a configured RP ID, and
 * neither is an IP literal.
 */
export function webauthnConfigProblems(origins: readonly string[], rpIds: readonly string[]): string[] {
  const problems: string[] = [];
  for (const rpId of rpIds) {
    if (isIpLiteral(rpId)) problems.push(`WEBAUTHN_RP_IDS: ${rpId} is an IP address (browsers refuse passkeys there)`);
    else if (!/^[a-z0-9.-]+$/i.test(rpId)) problems.push(`WEBAUTHN_RP_IDS: ${rpId} is not a host name`);
  }
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      problems.push(`WEBAUTHN_ORIGINS: ${origin} is not a URL`);
      continue;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin.replace(/\/$/, "")) {
      problems.push(`WEBAUTHN_ORIGINS: ${origin} must be scheme://host[:port] without a path`);
      continue;
    }
    if (isIpLiteral(url.hostname)) {
      problems.push(`WEBAUTHN_ORIGINS: ${origin} uses an IP address (browsers refuse passkeys there)`);
    } else if (!rpIds.includes(url.hostname)) {
      problems.push(`WEBAUTHN_ORIGINS: the host of ${origin} is not in WEBAUTHN_RP_IDS`);
    }
  }
  return problems;
}
