import { logger } from "@aktenraum/core";
import { Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";

import { DB, type Database } from "../db/db.module.js";
import { authAudit, type AuthAuditEvent } from "../db/schema.js";
import { clientIp, clientUserAgent } from "./session.service.js";

export interface AuthAuditFields {
  memberId?: number | null;
  actorMemberId?: number | null;
  sessionId?: number | null;
  /** The attempted name of a failed / throttled login. Never a password. */
  username?: string | null;
  reason?: string | null;
  /** Address and user agent are taken from here. */
  request?: Request | null;
}

/**
 * Authentication events (auth-server-sessions §8), kept 180 days. Best
 * effort like share_audit: a failed write logs and never fails the request.
 * Nothing here ever receives a session token or its hash.
 */
@Injectable()
export class AuthAuditService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async record(event: AuthAuditEvent, fields: AuthAuditFields = {}): Promise<void> {
    try {
      await this.db.insert(authAudit).values({
        event,
        memberId: fields.memberId ?? null,
        actorMemberId: fields.actorMemberId ?? null,
        sessionId: fields.sessionId ?? null,
        username: fields.username?.slice(0, 64) ?? null,
        reason: fields.reason?.slice(0, 32) ?? null,
        ip: fields.request ? clientIp(fields.request) : null,
        userAgent: fields.request ? clientUserAgent(fields.request) : null,
      });
    } catch (error: unknown) {
      logger.warn("auth_audit_failed", {
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** One `session_revoked` row per session. */
  async recordRevocations(
    sessionIds: number[],
    fields: { memberId: number; actorMemberId: number | null; reason: string; request?: Request | null },
  ): Promise<void> {
    for (const sessionId of sessionIds) {
      await this.record("session_revoked", { ...fields, sessionId });
    }
  }
}
