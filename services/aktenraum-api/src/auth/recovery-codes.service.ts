import { createHash, randomBytes } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";

import { DB, type Database } from "../db/db.module.js";
import { recoveryCodes } from "../db/schema.js";

/**
 * Recovery codes (auth-passkeys design §6): 16 Crockford-base32 characters
 * (80 bits) shown as XXXX-XXXX-XXXX-XXXX, stored as sha256 hex of the
 * normalised form. Ten per batch; a new batch invalidates the old unused ones.
 */

export const RECOVERY_CODES_PER_BATCH = 10;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 10 random bytes → 16 base32 characters, grouped by 4. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join("-");
}

/** Upper-case, spaces and dashes dropped, O→0, I/L→1 (Crockford's reading aids). */
export function normaliseRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export function hashRecoveryCode(input: string): string {
  return createHash("sha256").update(normaliseRecoveryCode(input)).digest("hex");
}

@Injectable()
export class RecoveryCodesService {
  constructor(@Inject(DB) private readonly db: Database) {}

  private unused(memberId: number) {
    return and(eq(recoveryCodes.memberId, memberId), isNull(recoveryCodes.usedAt), isNull(recoveryCodes.invalidatedAt));
  }

  /** A new batch; every unused code of the old one stops working. Returns the codes once. */
  async generate(memberId: number): Promise<string[]> {
    await this.db
      .update(recoveryCodes)
      .set({ invalidatedAt: sql`now()` as unknown as string })
      .where(this.unused(memberId));
    const batchId = randomBytes(16).toString("hex");
    const codes = Array.from({ length: RECOVERY_CODES_PER_BATCH }, generateRecoveryCode);
    await this.db
      .insert(recoveryCodes)
      .values(codes.map((code) => ({ memberId, batchId, codeHash: hashRecoveryCode(code) })));
    return codes;
  }

  async remaining(memberId: number): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(recoveryCodes)
      .where(this.unused(memberId));
    return Number(row?.count ?? 0);
  }

  /**
   * Uses one code atomically; true when it was an unused code of this member.
   * `memberId` null (unknown username) runs the same query against nobody, so
   * the work done doesn't tell whether the name exists.
   */
  async claim(memberId: number | null, code: string): Promise<boolean> {
    const rows = await this.db
      .update(recoveryCodes)
      .set({ usedAt: sql`now()` as unknown as string })
      .where(and(this.unused(memberId ?? -1), eq(recoveryCodes.codeHash, hashRecoveryCode(code))))
      .returning({ id: recoveryCodes.id });
    return rows.length > 0;
  }
}
