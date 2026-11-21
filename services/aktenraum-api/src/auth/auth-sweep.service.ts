import { logger } from "@aktenraum/core";
import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { or, sql } from "drizzle-orm";

import { DB, type Database } from "../db/db.module.js";
import { authAudit, authRateLimitEvents, credentialAudit, recoveryCodes, sessions, setupTokens, webauthnChallenges } from "../db/schema.js";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface AuthSweepResult {
  sessions: number;
  rate_limit_events: number;
  audit: number;
  challenges: number;
  setup_tokens: number;
  recovery_codes: number;
  credential_audit: number;
}

/**
 * Prunes what nobody reads any more (auth-server-sessions §10): sessions
 * revoked or expired more than 30 days ago (the device list shows only active
 * ones, the audit keeps the history), rate-limit events older than a day,
 * audit rows older than 180 days. auth-passkeys adds: WebAuthn challenges
 * expired more than a day ago, setup links expired / used / revoked more than
 * 30 days ago, used or invalidated recovery codes and credential audit rows
 * older than 180 days. At startup and hourly.
 */
@Injectable()
export class AuthSweepService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(@Inject(DB) private readonly db: Database) {}

  onApplicationBootstrap(): void {
    void this.sweepLogged();
    this.timer = setInterval(() => void this.sweepLogged(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async sweepLogged(): Promise<void> {
    try {
      const result = await this.sweep();
      if (Object.values(result).some((count) => count > 0)) logger.info("auth_sweep_completed", { ...result });
    } catch (error: unknown) {
      logger.warn("auth_sweep_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  async sweep(): Promise<AuthSweepResult> {
    const old = sql`now() - interval '30 days'`;
    const prunedSessions = await this.db
      .delete(sessions)
      .where(
        or(
          sql`${sessions.revokedAt} < ${old}`,
          sql`${sessions.idleExpiresAt} < ${old}`,
          sql`${sessions.absoluteExpiresAt} < ${old}`,
        ),
      )
      .returning({ id: sessions.id });
    const prunedEvents = await this.db
      .delete(authRateLimitEvents)
      .where(sql`${authRateLimitEvents.at} < now() - interval '1 day'`)
      .returning({ id: authRateLimitEvents.id });
    const prunedAudit = await this.db
      .delete(authAudit)
      .where(sql`${authAudit.at} < now() - interval '180 days'`)
      .returning({ id: authAudit.id });
    const prunedChallenges = await this.db
      .delete(webauthnChallenges)
      .where(sql`${webauthnChallenges.expiresAt} < now() - interval '1 day'`)
      .returning({ id: webauthnChallenges.id });
    const prunedSetup = await this.db
      .delete(setupTokens)
      .where(
        or(
          sql`${setupTokens.expiresAt} < ${old}`,
          sql`${setupTokens.usedAt} < ${old}`,
          sql`${setupTokens.revokedAt} < ${old}`,
        ),
      )
      .returning({ id: setupTokens.id });
    const halfYear = sql`now() - interval '180 days'`;
    const prunedCodes = await this.db
      .delete(recoveryCodes)
      .where(or(sql`${recoveryCodes.usedAt} < ${halfYear}`, sql`${recoveryCodes.invalidatedAt} < ${halfYear}`))
      .returning({ id: recoveryCodes.id });
    const prunedCredentialAudit = await this.db
      .delete(credentialAudit)
      .where(sql`${credentialAudit.at} < ${halfYear}`)
      .returning({ id: credentialAudit.id });
    return {
      sessions: prunedSessions.length,
      rate_limit_events: prunedEvents.length,
      audit: prunedAudit.length,
      challenges: prunedChallenges.length,
      setup_tokens: prunedSetup.length,
      recovery_codes: prunedCodes.length,
      credential_audit: prunedCredentialAudit.length,
    };
  }
}
