import { createHash, randomBytes } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "../db/db.module.js";
import { memberRemovals, members, setupTokens, users } from "../db/schema.js";

/**
 * Setup links (auth-passkeys design §7): 32 random bytes base64url, single
 * use, 30 minutes, only the sha256 stored. Plain functions over the database
 * so the host CLI (no Nest app) and the api share them.
 */

export const SETUP_LINK_MINUTES = 30;
export const SETUP_INVALID = "Einrichtungslink ungültig oder abgelaufen";

export function hashSetupToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Usable: not used, not revoked, not expired, member not removed (one clock: SQL). */
export const setupTokenPending = () =>
  and(
    isNull(setupTokens.usedAt),
    isNull(setupTokens.revokedAt),
    sql`${setupTokens.expiresAt} > now()`,
    sql`${setupTokens.memberId} NOT IN (SELECT ${memberRemovals.memberId} FROM ${memberRemovals})`,
  );

export interface CreatedSetupLink {
  id: number;
  /** Shown exactly once. */
  token: string;
  expires_at: string;
}

/** Issues a link for `memberId`; earlier unused links of that member are revoked. */
export async function createSetupLink(
  db: Database,
  memberId: number,
  createdByMemberId: number | null,
): Promise<CreatedSetupLink> {
  await db
    .update(setupTokens)
    .set({ revokedAt: sql`now()` as unknown as string })
    .where(and(eq(setupTokens.memberId, memberId), isNull(setupTokens.usedAt), isNull(setupTokens.revokedAt)));
  const token = randomBytes(32).toString("base64url");
  const [row] = await db
    .insert(setupTokens)
    .values({
      tokenHash: hashSetupToken(token),
      memberId,
      createdByMemberId,
      expiresAt: sql.raw(`now() + interval '${SETUP_LINK_MINUTES} minutes'`) as unknown as string,
    })
    .returning({ id: setupTokens.id, expiresAt: setupTokens.expiresAt });
  return { id: row!.id, token, expires_at: new Date(row!.expiresAt).toISOString() };
}

export interface PendingSetupLink {
  id: number;
  memberId: number;
  username: string;
  expiresAt: string;
}

export async function findPendingSetupLink(db: Database, token: string): Promise<PendingSetupLink | null> {
  if (typeof token !== "string" || token.length === 0 || token.length > 128) return null;
  const rows = await db
    .select({ id: setupTokens.id, memberId: setupTokens.memberId, username: users.username, expiresAt: setupTokens.expiresAt })
    .from(setupTokens)
    .innerJoin(members, eq(members.id, setupTokens.memberId))
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(setupTokens.tokenHash, hashSetupToken(token)), setupTokenPending()))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : { ...row, expiresAt: new Date(row.expiresAt).toISOString() };
}

/** Uses the link atomically; false when it was no longer pending. */
export async function claimSetupLink(db: Database, id: number): Promise<boolean> {
  const rows = await db
    .update(setupTokens)
    .set({ usedAt: sql`now()` as unknown as string })
    .where(and(eq(setupTokens.id, id), setupTokenPending()))
    .returning({ id: setupTokens.id });
  return rows.length > 0;
}
