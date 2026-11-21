import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time check of a shared secret. The primitive under
 * `serviceCaller`; used by the api and the worker.
 *
 * - `false` when `expected` is empty, so an unset secret fails closed.
 * - `false` for anything that isn't a string — callers pass the raw header
 *   value, which can be `undefined` or a repeated-header array.
 * - Both sides are SHA-256 hashed first, so the comparison runs over equal
 *   32-byte buffers and the secret's length doesn't leak through an early
 *   length check.
 */
export function secretMatches(provided: unknown, expected: string): boolean {
  if (!expected || typeof provided !== "string") return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The internal callers (ADR-010 step 5, `service-credentials`). */
export type ServiceName = "paperless-hook" | "worker" | "api";

export const SERVICE_NAMES: readonly ServiceName[] = ["paperless-hook", "worker", "api"];

/** Map of the credentials a service verifies against (or sends). */
export type ServiceCredentials = Partial<Record<ServiceName, string | undefined>>;

/** Credentials shorter than this are accepted but logged as weak. */
export const SERVICE_TOKEN_MIN_LENGTH = 32;

const BEARER_RE = /^bearer ([^\s]+)$/i;

/**
 * The bearer value of an `Authorization` header, or `null` unless the header
 * is exactly one string of the form `Bearer <value>` (scheme case-insensitive,
 * one space, no whitespace in the value).
 */
export function bearerValue(authorization: unknown): string | null {
  if (typeof authorization !== "string") return null;
  const match = BEARER_RE.exec(authorization);
  return match ? match[1]! : null;
}

/**
 * Which internal caller sent this `Authorization` header, or `null`.
 *
 * Compares the bearer value against EVERY configured credential (no early
 * exit) with `secretMatches`, and returns the single match. Empty credentials
 * never match; credentials that share a value with another one are dropped
 * first, so a duplicated value fails closed instead of picking a caller.
 */
export function serviceCaller(
  authorization: unknown,
  credentials: ServiceCredentials,
): ServiceName | null {
  const value = bearerValue(authorization);
  if (value === null) return null;
  const duplicate = new Set(checkServiceCredentials(credentials).duplicate);
  let found: ServiceName | null = null;
  let matches = 0;
  for (const name of SERVICE_NAMES) {
    if (!(name in credentials)) continue;
    const expected = duplicate.has(name) ? "" : (credentials[name] ?? "");
    if (secretMatches(value, expected)) {
      found = name;
      matches += 1;
    }
  }
  return matches === 1 ? found : null;
}

export interface ServiceCredentialCheck {
  /** Configured key with an empty value. */
  unset: ServiceName[];
  /** Non-empty value shared with at least one other credential. */
  duplicate: ServiceName[];
  /** Non-empty, unique, but shorter than `SERVICE_TOKEN_MIN_LENGTH`. */
  weak: ServiceName[];
}

/**
 * Startup check of the credentials a service holds. Only the keys present in
 * `credentials` are checked, so each service passes exactly the ones it uses.
 * Never returns or logs a value.
 */
export function checkServiceCredentials(credentials: ServiceCredentials): ServiceCredentialCheck {
  const result: ServiceCredentialCheck = { unset: [], duplicate: [], weak: [] };
  const names = SERVICE_NAMES.filter((n) => n in credentials);
  for (const name of names) {
    const value = credentials[name] ?? "";
    if (!value) {
      result.unset.push(name);
      continue;
    }
    if (names.some((other) => other !== name && credentials[other] === value)) {
      result.duplicate.push(name);
      continue;
    }
    if (value.length < SERVICE_TOKEN_MIN_LENGTH) result.weak.push(name);
  }
  return result;
}

type WarnLogger = { warn: (event: string, fields?: Record<string, unknown>) => void };

/**
 * Startup log for missing / duplicated / weak credentials (`service_token_unset`,
 * `service_token_duplicate`, `service_token_weak`). Logs names, never values.
 */
export function logServiceCredentialCheck(credentials: ServiceCredentials, log: WarnLogger): void {
  const { unset, duplicate, weak } = checkServiceCredentials(credentials);
  if (unset.length > 0) {
    log.warn("service_token_unset", {
      services: unset,
      detail:
        "Internal calls that need these credentials are rejected. " +
        "Run scripts/bootstrap-secrets.sh, then `docker compose up -d`.",
    });
  }
  if (duplicate.length > 0) {
    log.warn("service_token_duplicate", {
      services: duplicate,
      detail: "Credentials share a value, so the callers can't be told apart — both are treated as unset.",
    });
  }
  if (weak.length > 0) {
    log.warn("service_token_weak", {
      services: weak,
      detail: "Credentials shorter than 32 characters; regenerate with scripts/bootstrap-secrets.sh.",
    });
  }
}
