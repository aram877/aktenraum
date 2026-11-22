import { createHash, randomBytes } from "node:crypto";

import { logger } from "@aktenraum/core";
import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, isNull, or, sql, type SQL } from "drizzle-orm";

import { DB, type Database } from "../db/db.module.js";
import { members, personalAccessTokens, users, type TokenRevokedReason } from "../db/schema.js";
import { isTokenScope, type TokenScope } from "./principal.js";

/**
 * Personal access tokens (personal-access-tokens, ADR-010 step 6). The value
 * is `akt_pat_` + 32 random bytes as base64url; the database stores only its
 * sha256 hex (256 bits of entropy: no pepper, no slow hash — as for session
 * tokens and recovery codes). Every expiry decision uses the database clock.
 */

export const TOKEN_PREFIX = "akt_pat_";
export const MAX_ACTIVE_TOKENS = 25;
export const TOKEN_MAX_DAYS = 365;
/** `akt_pat_` + 4 characters: enough to recognise a token, useless to guess one. */
export const DISPLAY_PREFIX_LENGTH = 12;
/** Revoked / expired tokens stay in the list (and the table) this long. */
export const TOKEN_HISTORY_DAYS = 30;

const VALUE_RE = /^akt_pat_[A-Za-z0-9_-]{43}$/;

/** Active = not revoked, not expired. */
const active: SQL = sql`(${personalAccessTokens.revokedAt} IS NULL AND ${personalAccessTokens.expiresAt} > now())`;

export function hashTokenValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateTokenValue(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** Whether a bearer value has the exact PAT shape (cheap check before any lookup). */
export function isTokenValue(value: string): boolean {
  return VALUE_RE.test(value);
}

/**
 * The stored comma list → token scopes. Unknown entries are dropped (and
 * logged), so a hand-edited row can never grant more than TOKEN_SCOPES.
 */
export function parseStoredScopes(stored: string, tokenId?: number): TokenScope[] {
  const out: TokenScope[] = [];
  for (const raw of stored.split(",")) {
    const scope = raw.trim();
    if (scope === "") continue;
    if (!isTokenScope(scope)) {
      logger.warn("pat_unknown_scope_ignored", { token_id: tokenId ?? null, scope: scope.slice(0, 32) });
      continue;
    }
    if (!out.includes(scope)) out.push(scope);
  }
  return out;
}

function expiryInterval(daysValue: number): SQL {
  if (!Number.isInteger(daysValue) || daysValue < 1 || daysValue > TOKEN_MAX_DAYS) {
    throw new Error(`invalid token expiry ${daysValue}`);
  }
  // A validated integer, safe to inline (same form as the session expiry).
  return sql.raw(`interval '${daysValue} days'`);
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function isoOrNull(value: string | Date | null): string | null {
  return value === null ? null : iso(value);
}

export type TokenState = "active" | "expired" | "revoked";

export interface TokenListEntry {
  id: number;
  name: string;
  scopes: TokenScope[];
  display_prefix: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  revoked_at: string | null;
  state: TokenState;
}

export interface ActiveToken {
  id: number;
  memberId: number;
  userId: number;
  username: string;
  name: string;
  scopes: TokenScope[];
  createdAt: string;
}

export type TokenResolution =
  | { status: "active"; token: ActiveToken }
  /** `auditDue`: the hourly `token_rejected_expired` audit write is due. */
  | { status: "expired"; id: number; memberId: number; name: string; displayPrefix: string; auditDue: boolean }
  | { status: "revoked" }
  | { status: "unknown" };

export interface RevokedToken {
  id: number;
  name: string;
  displayPrefix: string;
}

export class TokenLimitError extends Error {
  constructor() {
    super(`at most ${MAX_ACTIVE_TOKENS} active tokens`);
  }
}

@Injectable()
export class TokenService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async create(
    member: { memberId: number; householdId: number },
    input: { name: string; scopes: readonly TokenScope[]; expiresInDays: number },
  ): Promise<{ token: TokenListEntry; value: string }> {
    const scopes = parseStoredScopes(input.scopes.join(","));
    if (scopes.length === 0) throw new Error("a token needs at least one scope");
    const interval = expiryInterval(input.expiresInDays);
    const [current] = await this.db
      .select({ n: count() })
      .from(personalAccessTokens)
      .where(and(eq(personalAccessTokens.memberId, member.memberId), active));
    if (Number(current?.n ?? 0) >= MAX_ACTIVE_TOKENS) throw new TokenLimitError();

    const value = generateTokenValue();
    const [row] = await this.db
      .insert(personalAccessTokens)
      .values({
        memberId: member.memberId,
        householdId: member.householdId,
        name: input.name,
        tokenHash: hashTokenValue(value),
        displayPrefix: value.slice(0, DISPLAY_PREFIX_LENGTH),
        scopes: scopes.join(","),
        expiresAt: sql`now() + ${interval}` as unknown as string,
      })
      .returning({ id: personalAccessTokens.id });
    const token = (await this.listWhere(eq(personalAccessTokens.id, row!.id)))[0]!;
    return { token, value };
  }

  /** The member's tokens, newest first: active ones plus those ended in the last 30 days. */
  list(memberId: number): Promise<TokenListEntry[]> {
    const history = sql.raw(`now() - interval '${TOKEN_HISTORY_DAYS} days'`);
    return this.listWhere(
      and(
        eq(personalAccessTokens.memberId, memberId),
        or(
          active,
          sql`${personalAccessTokens.revokedAt} > ${history}`,
          sql`(${personalAccessTokens.revokedAt} IS NULL AND ${personalAccessTokens.expiresAt} > ${history})`,
        ),
      ),
    );
  }

  private async listWhere(where: SQL | undefined): Promise<TokenListEntry[]> {
    const rows = await this.db
      .select({
        id: personalAccessTokens.id,
        name: personalAccessTokens.name,
        scopes: personalAccessTokens.scopes,
        displayPrefix: personalAccessTokens.displayPrefix,
        createdAt: personalAccessTokens.createdAt,
        expiresAt: personalAccessTokens.expiresAt,
        lastUsedAt: personalAccessTokens.lastUsedAt,
        lastUsedIp: personalAccessTokens.lastUsedIp,
        revokedAt: personalAccessTokens.revokedAt,
        isActive: sql<boolean>`${active}`,
      })
      .from(personalAccessTokens)
      .where(where)
      .orderBy(desc(personalAccessTokens.createdAt), desc(personalAccessTokens.id));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      scopes: parseStoredScopes(row.scopes, row.id),
      display_prefix: row.displayPrefix,
      created_at: iso(row.createdAt),
      expires_at: iso(row.expiresAt),
      last_used_at: isoOrNull(row.lastUsedAt),
      last_used_ip: row.lastUsedIp,
      revoked_at: isoOrNull(row.revokedAt),
      state: row.revokedAt !== null ? "revoked" : row.isActive === true ? "active" : "expired",
    }));
  }

  /**
   * Revokes one of the member's own tokens. Returns the token (also when it
   * was already revoked — idempotent) with `changed`, or null when the id is
   * not the member's: someone else's and unknown look the same.
   */
  async revoke(
    memberId: number,
    tokenId: number,
    actorMemberId: number,
    reason: TokenRevokedReason = "user",
  ): Promise<{ token: RevokedToken; changed: boolean } | null> {
    const [own] = await this.db
      .select({ id: personalAccessTokens.id, name: personalAccessTokens.name, displayPrefix: personalAccessTokens.displayPrefix })
      .from(personalAccessTokens)
      .where(and(eq(personalAccessTokens.id, tokenId), eq(personalAccessTokens.memberId, memberId)))
      .limit(1);
    if (own === undefined) return null;
    const changed = await this.revokeWhere(eq(personalAccessTokens.id, own.id), reason, actorMemberId);
    return { token: own, changed: changed.length > 0 };
  }

  /** Every unrevoked token of the member (expired ones included, so the list is honest). */
  revokeAllOfMember(memberId: number, reason: TokenRevokedReason, actorMemberId: number | null): Promise<RevokedToken[]> {
    return this.revokeWhere(eq(personalAccessTokens.memberId, memberId), reason, actorMemberId);
  }

  private async revokeWhere(where: SQL, reason: TokenRevokedReason, actorMemberId: number | null): Promise<RevokedToken[]> {
    return this.db
      .update(personalAccessTokens)
      .set({ revokedAt: sql`now()` as unknown as string, revokedReason: reason, revokedByMemberId: actorMemberId })
      .where(and(where, isNull(personalAccessTokens.revokedAt)))
      .returning({ id: personalAccessTokens.id, name: personalAccessTokens.name, displayPrefix: personalAccessTokens.displayPrefix });
  }

  /**
   * The token behind a bearer value. One indexed lookup (token ⋈ member ⋈
   * user); an active token's usage is recorded at most once a minute, and a
   * failed usage write never fails the request.
   */
  async resolve(value: string, ip: string | null): Promise<TokenResolution> {
    if (!isTokenValue(value)) return { status: "unknown" };
    const rows = await this.db
      .select({
        id: personalAccessTokens.id,
        memberId: personalAccessTokens.memberId,
        userId: members.userId,
        username: users.username,
        name: personalAccessTokens.name,
        displayPrefix: personalAccessTokens.displayPrefix,
        scopes: personalAccessTokens.scopes,
        createdAt: personalAccessTokens.createdAt,
        revoked: sql<boolean>`(${personalAccessTokens.revokedAt} IS NOT NULL)`,
        isActive: sql<boolean>`${active}`,
        stale: sql<boolean>`(${personalAccessTokens.lastUsedAt} IS NULL OR ${personalAccessTokens.lastUsedAt} < now() - interval '1 minute')`,
      })
      .from(personalAccessTokens)
      .innerJoin(members, eq(members.id, personalAccessTokens.memberId))
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(personalAccessTokens.tokenHash, hashTokenValue(value)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return { status: "unknown" };
    if (row.revoked === true) return { status: "revoked" };
    if (row.isActive !== true) {
      return {
        status: "expired",
        id: row.id,
        memberId: row.memberId,
        name: row.name,
        displayPrefix: row.displayPrefix,
        auditDue: await this.claimExpiredAudit(row.id),
      };
    }
    if (row.stale === true) await this.recordUse(row.id, ip);
    return {
      status: "active",
      token: {
        id: row.id,
        memberId: row.memberId,
        userId: row.userId,
        username: row.username,
        name: row.name,
        scopes: parseStoredScopes(row.scopes, row.id),
        createdAt: iso(row.createdAt),
      },
    };
  }

  private async recordUse(id: number, ip: string | null): Promise<void> {
    try {
      await this.db
        .update(personalAccessTokens)
        .set({ lastUsedAt: sql`now()` as unknown as string, lastUsedIp: ip === null ? null : ip.slice(0, 64) })
        .where(
          and(
            eq(personalAccessTokens.id, id),
            sql`(${personalAccessTokens.lastUsedAt} IS NULL OR ${personalAccessTokens.lastUsedAt} < now() - interval '1 minute')`,
          ),
        );
    } catch (error: unknown) {
      logger.warn("pat_usage_update_failed", { token_id: id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** True at most once an hour per token: whether to audit a use after expiry. */
  private async claimExpiredAudit(id: number): Promise<boolean> {
    try {
      const rows = await this.db
        .update(personalAccessTokens)
        .set({ expiredAuditAt: sql`now()` as unknown as string })
        .where(
          and(
            eq(personalAccessTokens.id, id),
            sql`(${personalAccessTokens.expiredAuditAt} IS NULL OR ${personalAccessTokens.expiredAuditAt} < now() - interval '1 hour')`,
          ),
        )
        .returning({ id: personalAccessTokens.id });
      return rows.length > 0;
    } catch {
      return false;
    }
  }
}
