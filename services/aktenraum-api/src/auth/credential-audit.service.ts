import { logger } from "@aktenraum/core";
import { Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";

import { DB, type Database } from "../db/db.module.js";
import { credentialAudit, type CredentialAuditEvent } from "../db/schema.js";
import { clientIp, clientUserAgent } from "./session.service.js";

export interface CredentialAuditFields {
  memberId?: number | null;
  actorMemberId?: number | null;
  sessionId?: number | null;
  passkeyId?: number | null;
  /** A passkey name / address, a reason. Never a code, token, hash or key. */
  detail?: string | null;
  request?: Request | null;
}

/**
 * Credential events (auth-passkeys design §1, §11): passkeys, recovery codes,
 * setup links, password retirement, step-up. Kept 180 days; best effort like
 * `AuthAuditService` — a failed write logs and never fails the request.
 */
@Injectable()
export class CredentialAuditService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async record(event: CredentialAuditEvent, fields: CredentialAuditFields = {}): Promise<void> {
    try {
      await this.db.insert(credentialAudit).values({
        event,
        memberId: fields.memberId ?? null,
        actorMemberId: fields.actorMemberId ?? null,
        sessionId: fields.sessionId ?? null,
        passkeyId: fields.passkeyId ?? null,
        detail: fields.detail?.slice(0, 128) ?? null,
        ip: fields.request ? clientIp(fields.request) : null,
        userAgent: fields.request ? clientUserAgent(fields.request) : null,
      });
    } catch (error: unknown) {
      logger.warn("credential_audit_failed", {
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
