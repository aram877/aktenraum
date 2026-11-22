import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";

import { DB, type Database } from "../db/db.module.js";
import { authRateLimitEvents } from "../db/schema.js";

export const AUTH_MAX_FAILURES = 10;
/** Kept as an SQL literal: the window is evaluated by the database clock. */
export const AUTH_WINDOW_MINUTES = 15;
const WINDOW = sql.raw(`interval '${AUTH_WINDOW_MINUTES} minutes'`);

export const loginUserKey = (username: string): string => `login:user:${username.trim().toLowerCase()}`.slice(0, 160);
export const loginIpKey = (ip: string | null): string => `login:ip:${ip ?? "unknown"}`;
export const inviteIpKey = (ip: string | null): string => `invite:ip:${ip ?? "unknown"}`;
/** Failed personal-access-token attempts per client address (personal-access-tokens D7). */
export const tokenIpKey = (ip: string | null): string => `token:ip:${ip ?? "unknown"}`;
export const setupIpKey = (ip: string | null): string => `setup:ip:${ip ?? "unknown"}`;

/**
 * Failed login / invite attempts, persisted in Postgres so a restart doesn't
 * reset them (auth-server-sessions §6). One row per failure; a key is
 * throttled with ≥ AUTH_MAX_FAILURES rows inside the window.
 */
@Injectable()
export class AuthRateLimiter {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Seconds until the first throttled key is free again, or null when none
   * is throttled. Retry-After = until the oldest counted event leaves the
   * window; both timestamps come from the same query (one clock).
   */
  async retryAfterSeconds(keys: string[]): Promise<number | null> {
    let longest: number | null = null;
    for (const key of keys) {
      const [row] = await this.db
        .select({
          count: sql<number>`count(*)::int`,
          until: sql<string | Date | null>`min(${authRateLimitEvents.at}) + ${WINDOW}`,
          now: sql<string | Date>`now()`,
        })
        .from(authRateLimitEvents)
        .where(and(eq(authRateLimitEvents.key, key), sql`${authRateLimitEvents.at} > now() - ${WINDOW}`));
      if (row === undefined || Number(row.count) < AUTH_MAX_FAILURES || row.until === null) continue;
      const seconds = Math.max(1, Math.ceil((new Date(row.until).getTime() - new Date(row.now).getTime()) / 1000));
      longest = longest === null ? seconds : Math.max(longest, seconds);
    }
    return longest;
  }

  async recordFailure(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.db.insert(authRateLimitEvents).values(keys.map((key) => ({ key })));
  }

  async reset(key: string): Promise<void> {
    await this.db.delete(authRateLimitEvents).where(eq(authRateLimitEvents.key, key));
  }
}
