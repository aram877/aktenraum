import { createHash, randomBytes } from "node:crypto";

import { logger } from "@aktenraum/core";
import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, ne, sql, type SQL } from "drizzle-orm";
import type { CookieOptions, Request, Response } from "express";

import { SETTINGS, type Settings } from "../config/settings.js";
import { DB, type Database } from "../db/db.module.js";
import {
  memberRemovals,
  members,
  sessions,
  users,
  type SessionAuthMethod,
  type SessionRevokedReason,
} from "../db/schema.js";

/**
 * Server-side browser sessions (auth-server-sessions, ADR-010 §3). The cookie
 * holds 32 random bytes (base64url); the database stores only their sha256
 * hex, so nothing read from the database or the logs works as a cookie.
 * Every expiry decision is made by the database clock.
 */

const USER_AGENT_MAX = 512;
const IP_MAX = 64;

/** Active = not revoked, inside both expiries. */
const active: SQL = sql`(${sessions.revokedAt} IS NULL AND ${sessions.idleExpiresAt} > now() AND ${sessions.absoluteExpiresAt} > now())`;

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A validated integer setting, safe to inline into an interval literal. */
function days(n: number): SQL {
  if (!Number.isInteger(n) || n < 1) throw new Error(`invalid day count ${n}`);
  return sql.raw(`interval '${n} days'`);
}

export interface ResolvedSession {
  sessionId: number;
  memberId: number;
  userId: number;
  username: string;
  createdAt: string;
}

export interface SessionListEntry {
  id: number;
  created_at: string;
  last_seen_at: string;
  auth_method: SessionAuthMethod;
  ip: string | null;
  user_agent: string | null;
  current: boolean;
}

export type SessionState = "active" | "revoked" | "expired";

export function clientIp(request: Request): string | null {
  const ip = request.ip ?? request.socket?.remoteAddress ?? null;
  return ip === null || ip === "" ? null : ip.slice(0, IP_MAX);
}

export function clientUserAgent(request: Request): string | null {
  const agent = request.headers["user-agent"];
  return typeof agent === "string" && agent !== "" ? agent.slice(0, USER_AGENT_MAX) : null;
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

@Injectable()
export class SessionService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  // -------------------------------------------------------------------------
  // Cookie
  // -------------------------------------------------------------------------

  /** `__Host-<name>` on HTTPS (Secure, Path=/, no Domain), the plain name otherwise. */
  cookieName(): string {
    return this.settings.COOKIE_SECURE ? `__Host-${this.settings.COOKIE_NAME}` : this.settings.COOKIE_NAME;
  }

  private otherCookieName(): string {
    return this.settings.COOKIE_SECURE ? this.settings.COOKIE_NAME : `__Host-${this.settings.COOKIE_NAME}`;
  }

  private cookieOptions(): CookieOptions {
    return { httpOnly: true, secure: this.settings.COOKIE_SECURE, sameSite: "lax", path: "/" };
  }

  readToken(request: Request): string | null {
    const token: unknown = (request.cookies as Record<string, unknown> | undefined)?.[this.cookieName()];
    return typeof token === "string" && token !== "" ? token : null;
  }

  private clearCookie(response: Response, name: string): void {
    // A browser only accepts a __Host- cookie (even an expired one) with Secure.
    response.clearCookie(name, { ...this.cookieOptions(), secure: this.settings.COOKIE_SECURE || name.startsWith("__Host-") });
  }

  /** Clears both names, so an old JWT cookie never lingers next to the new one. */
  clearCookies(response: Response): void {
    this.clearCookie(response, this.cookieName());
    this.clearCookie(response, this.otherCookieName());
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Creates the session row and sets the cookie. Returns the session id. */
  async issue(
    response: Response,
    request: Request,
    member: { id: number; householdId: number },
    method: SessionAuthMethod,
  ): Promise<number> {
    const token = randomBytes(32).toString("base64url");
    const absolute = this.settings.SESSION_ABSOLUTE_DAYS;
    const idle = Math.min(this.settings.SESSION_IDLE_DAYS, absolute);
    const [row] = await this.db
      .insert(sessions)
      .values({
        tokenHash: hashSessionToken(token),
        memberId: member.id,
        householdId: member.householdId,
        authMethod: method,
        idleExpiresAt: sql`now() + ${days(idle)}` as unknown as string,
        absoluteExpiresAt: sql`now() + ${days(absolute)}` as unknown as string,
        userAgent: clientUserAgent(request),
        ip: clientIp(request),
      })
      .returning({ id: sessions.id });
    this.clearCookie(response, this.otherCookieName());
    // The cookie lives as long as the longest possible session; the server decides expiry.
    response.cookie(this.cookieName(), token, { ...this.cookieOptions(), maxAge: absolute * 24 * 60 * 60 * 1000 });
    return row!.id;
  }

  /**
   * The active session behind a cookie token, or null. Slides the idle expiry
   * at most once a minute, never past the absolute expiry; a failed touch
   * never fails the request.
   */
  async resolve(token: string): Promise<ResolvedSession | null> {
    const rows = await this.db
      .select({
        sessionId: sessions.id,
        memberId: sessions.memberId,
        userId: members.userId,
        username: users.username,
        createdAt: sessions.createdAt,
        stale: sql<boolean>`${sessions.lastSeenAt} < now() - interval '1 minute'`,
      })
      .from(sessions)
      .innerJoin(members, eq(members.id, sessions.memberId))
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(sessions.tokenHash, hashSessionToken(token)), active))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    if (row.stale === true) await this.touch(row.sessionId);
    return {
      sessionId: row.sessionId,
      memberId: row.memberId,
      userId: row.userId,
      username: row.username,
      createdAt: iso(row.createdAt),
    };
  }

  private async touch(sessionId: number): Promise<void> {
    const idle = days(this.settings.SESSION_IDLE_DAYS);
    try {
      await this.db
        .update(sessions)
        .set({
          lastSeenAt: sql`now()` as unknown as string,
          // least(now() + idle, absolute), spelled as CASE so pg-mem runs it too.
          idleExpiresAt: sql`CASE WHEN now() + ${idle} < ${sessions.absoluteExpiresAt} THEN now() + ${idle} ELSE ${sessions.absoluteExpiresAt} END` as unknown as string,
        })
        .where(and(eq(sessions.id, sessionId), sql`${sessions.lastSeenAt} < now() - interval '1 minute'`, active));
    } catch (error: unknown) {
      logger.warn("session_touch_failed", {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * For open streams, by primary key, no touch. A removed member's session
   * counts as revoked (defence in depth: the removal also revokes the rows).
   */
  async state(sessionId: number): Promise<SessionState> {
    const rows = await this.db
      .select({
        revoked: sql<boolean>`(${sessions.revokedAt} IS NOT NULL OR EXISTS (SELECT 1 FROM ${memberRemovals} WHERE ${memberRemovals.memberId} = ${sessions.memberId}))`,
        isActive: sql<boolean>`${active}`,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const row = rows[0];
    if (row === undefined || row.revoked === true) return "revoked";
    return row.isActive === true ? "active" : "expired";
  }

  /** The active session behind a token without touching it (logout). */
  async findActiveByToken(token: string): Promise<{ sessionId: number; memberId: number } | null> {
    const rows = await this.db
      .select({ sessionId: sessions.id, memberId: sessions.memberId })
      .from(sessions)
      .where(and(eq(sessions.tokenHash, hashSessionToken(token)), active))
      .limit(1);
    return rows[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Revocation
  // -------------------------------------------------------------------------

  private async revokeWhere(where: SQL | undefined, reason: SessionRevokedReason): Promise<number[]> {
    const rows = await this.db
      .update(sessions)
      .set({ revokedAt: sql`now()` as unknown as string, revokedReason: reason })
      .where(and(where, isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return rows.map((row) => row.id);
  }

  /** One session; returns whether it was still unrevoked. */
  async revoke(sessionId: number, reason: SessionRevokedReason): Promise<boolean> {
    return (await this.revokeWhere(eq(sessions.id, sessionId), reason)).length > 0;
  }

  /** One of the member's own active sessions; false = not theirs or not active. */
  async revokeOwn(memberId: number, sessionId: number, reason: SessionRevokedReason): Promise<boolean> {
    const ids = await this.revokeWhere(
      and(eq(sessions.id, sessionId), eq(sessions.memberId, memberId), active),
      reason,
    );
    return ids.length > 0;
  }

  /** Every unrevoked session of the member (expired ones included, harmlessly). */
  revokeAllOfMember(memberId: number, reason: SessionRevokedReason): Promise<number[]> {
    return this.revokeWhere(eq(sessions.memberId, memberId), reason);
  }

  /** Every active session of the member except `keepSessionId`. */
  revokeOthers(memberId: number, keepSessionId: number, reason: SessionRevokedReason): Promise<number[]> {
    return this.revokeWhere(and(eq(sessions.memberId, memberId), ne(sessions.id, keepSessionId), active), reason);
  }

  // -------------------------------------------------------------------------
  // Device list
  // -------------------------------------------------------------------------

  async listActive(memberId: number, currentSessionId: number | null): Promise<SessionListEntry[]> {
    const rows = await this.db
      .select({
        id: sessions.id,
        createdAt: sessions.createdAt,
        lastSeenAt: sessions.lastSeenAt,
        authMethod: sessions.authMethod,
        ip: sessions.ip,
        userAgent: sessions.userAgent,
      })
      .from(sessions)
      .where(and(eq(sessions.memberId, memberId), active))
      .orderBy(desc(sessions.lastSeenAt), desc(sessions.id));
    return rows.map((row) => ({
      id: row.id,
      created_at: iso(row.createdAt),
      last_seen_at: iso(row.lastSeenAt),
      auth_method: row.authMethod,
      ip: row.ip,
      user_agent: row.userAgent,
      current: row.id === currentSessionId,
    }));
  }
}
