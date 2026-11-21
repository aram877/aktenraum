import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Request, Response } from "express";

import { DB, type Database } from "../db/db.module.js";
import { passwordRetirements } from "../db/schema.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { AuthAuditService } from "./auth-audit.service.js";
import { CredentialAuditService } from "./credential-audit.service.js";
import { RecoveryCodesService } from "./recovery-codes.service.js";
import { SessionService } from "./session.service.js";
import type { PasskeyRecord, VerifiedRegistration } from "./webauthn.service.js";
import { WebauthnService } from "./webauthn.service.js";

export interface EnrolmentResult {
  passkey: PasskeyRecord;
  /** Shown exactly once; null when the member still had unused codes. */
  recoveryCodes: string[] | null;
  sessionId: number;
}

/**
 * The step every "first passkey" flow ends with (auth-passkeys design §4, §7,
 * §8): store the passkey → recovery codes → retire the password → (enrol only)
 * revoke the restricted sessions → a fresh session with a step-up, never an
 * upgraded one (no session fixation).
 */
@Injectable()
export class EnrolmentService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly webauthn: WebauthnService,
    private readonly recovery: RecoveryCodesService,
    private readonly sessions: SessionService,
    private readonly tenancy: TenancyService,
    private readonly audit: AuthAuditService,
    private readonly credentialAudit: CredentialAuditService,
  ) {}

  /** Inserts the retirement row once; true when this call retired the password. */
  async retirePassword(memberId: number, sessionId: number | null): Promise<boolean> {
    const rows = await this.db
      .insert(passwordRetirements)
      .values({ memberId, sessionId })
      .onConflictDoNothing()
      .returning({ memberId: passwordRetirements.memberId });
    return rows.length > 0;
  }

  async isRetired(memberId: number): Promise<boolean> {
    const rows = await this.db
      .select({ memberId: passwordRetirements.memberId })
      .from(passwordRetirements)
      .where(eq(passwordRetirements.memberId, memberId))
      .limit(1);
    return rows.length > 0;
  }

  async complete(input: {
    memberId: number;
    verified: VerifiedRegistration;
    name?: string | null;
    method: "passkey" | "setup" | "invite";
    /** The restricted session that enrolled (enrol flow only). */
    currentSession?: { id: number; authMethod: string } | null;
    /** Setup links always issue a new batch; the others only when none is unused. */
    freshCodes?: boolean;
    request: Request;
    response: Response;
  }): Promise<EnrolmentResult> {
    const { memberId, request, response } = input;
    const member = await this.tenancy.memberById(memberId);
    if (member === null) throw new UnauthorizedException("Not authenticated");
    const currentSessionId = input.currentSession?.id ?? null;

    const passkey = await this.webauthn.storePasskey(memberId, input.verified, input.name);
    await this.credentialAudit.record("passkey_added", {
      memberId,
      actorMemberId: memberId,
      sessionId: currentSessionId,
      passkeyId: passkey.id,
      detail: `${passkey.name} @ ${passkey.rpId}`,
      request,
    });

    let recoveryCodes: string[] | null = null;
    if (input.freshCodes === true || (await this.recovery.remaining(memberId)) === 0) {
      recoveryCodes = await this.recovery.generate(memberId);
      await this.credentialAudit.record("recovery_codes_generated", { memberId, actorMemberId: memberId, sessionId: currentSessionId, request });
    }

    if (await this.retirePassword(memberId, currentSessionId)) {
      await this.credentialAudit.record("password_retired", { memberId, sessionId: currentSessionId, request });
    }

    if (input.currentSession != null) {
      // Every password session of the member ends (they are restricted for
      // good), the enrolling recovery session too; the new cookie replaces it.
      const revoked = await this.sessions.revokeByMethod(memberId, "password", "password_change");
      await this.audit.recordRevocations(revoked, { memberId, actorMemberId: memberId, reason: "password_change", request });
      if (input.currentSession.authMethod !== "password" && (await this.sessions.revoke(input.currentSession.id, "user"))) {
        await this.audit.recordRevocations([input.currentSession.id], { memberId, actorMemberId: memberId, reason: "user", request });
      }
    }

    const sessionId = await this.sessions.issue(response, request, member, input.method, { stepUp: true });
    return { passkey, recoveryCodes, sessionId };
  }
}
