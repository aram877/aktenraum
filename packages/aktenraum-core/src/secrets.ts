import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time check of a shared secret (today: `X-Aktenraum-Secret` against
 * `WEBHOOK_SECRET`). The one implementation used by the api and the worker.
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
