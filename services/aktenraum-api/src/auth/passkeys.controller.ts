import { logger } from "@aktenraum/core";
import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Request, Response } from "express";
import { z } from "zod";

import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { AuthAuditService } from "./auth-audit.service.js";
import { AuthGuard } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";
import { CredentialAuditService } from "./credential-audit.service.js";
import { EnrolmentService } from "./enrolment.service.js";
import {
  AllowRestricted,
  CurrentPrincipal,
  RequireScope,
  RequireStepUp,
  assertStepUp,
  type MemberPrincipal,
  type Principal,
} from "./principal.js";
import { AuthRateLimiter, loginIpKey, loginUserKey } from "./rate-limiter.js";
import { RecoveryCodesService } from "./recovery-codes.service.js";
import { SessionService, clientIp } from "./session.service.js";
import { PASSKEY_REJECTED, WebauthnService, type Ceremony, type PasskeyView } from "./webauthn.service.js";

export const THROTTLED = "Zu viele fehlgeschlagene Anmeldeversuche. Bitte später erneut versuchen.";
export const RECOVERY_REJECTED = "Benutzername oder Wiederherstellungscode falsch";

/** A WebAuthn response as the browser library sends it; verified by @simplewebauthn/server. */
const credentialSchema = z.object({ id: z.string().min(1).max(1366) }).passthrough();

export const finishSchema = z.object({
  ceremony: z.string().min(1).max(43),
  response: credentialSchema,
});
export type FinishRequest = z.infer<typeof finishSchema>;

const registerBeginSchema = z.object({ name: z.string().trim().max(64).optional() }).default({});
type RegisterBeginRequest = z.infer<typeof registerBeginSchema>;

const registerFinishSchema = finishSchema.extend({ name: z.string().trim().max(64).optional() });
type RegisterFinishRequest = z.infer<typeof registerFinishSchema>;

const renameSchema = z.object({ name: z.string().trim().min(1).max(64) });
type RenameRequest = z.infer<typeof renameSchema>;

const recoverySchema = z.object({
  username: z.string().min(1).max(64),
  code: z.string().min(1).max(64),
});
type RecoveryRequest = z.infer<typeof recoverySchema>;

function memberOf(principal: Principal): MemberPrincipal {
  if (principal.kind !== "member" || principal.sessionId === null) throw new UnauthorizedException("Not authenticated");
  return principal;
}

/** Throws 429 (with Retry-After) when any key is throttled. */
export async function refuseThrottled(limiter: AuthRateLimiter, keys: string[], response: Response): Promise<void> {
  const retryAfter = await limiter.retryAfterSeconds(keys);
  if (retryAfter !== null) {
    response.setHeader("Retry-After", String(retryAfter));
    throw new HttpException(THROTTLED, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/**
 * Passkeys (auth-passkeys): discoverable sign-in, enrolment and management,
 * step-up confirmation, recovery codes. Login, recovery and `/webauthn` are
 * public on purpose (route-inventory allowlist).
 */
@Controller("auth")
export class PasskeysController {
  constructor(
    private readonly webauthn: WebauthnService,
    private readonly enrolment: EnrolmentService,
    private readonly sessions: SessionService,
    private readonly tenancy: TenancyService,
    private readonly authService: AuthService,
    private readonly recovery: RecoveryCodesService,
    private readonly limiter: AuthRateLimiter,
    private readonly audit: AuthAuditService,
    private readonly credentialAudit: CredentialAuditService,
  ) {}

  /** Where passkeys work — the login page compares it with its own origin. */
  @Get("webauthn")
  config(): { origins: string[] } {
    return { origins: this.webauthn.origins() };
  }

  // -------------------------------------------------------------------------
  // Sign in
  // -------------------------------------------------------------------------

  @Post("passkeys/login/begin")
  @HttpCode(HttpStatus.OK)
  async loginBegin(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Ceremony<PublicKeyCredentialRequestOptionsJSON>> {
    await refuseThrottled(this.limiter, [loginIpKey(clientIp(request))], response);
    return this.webauthn.beginAuthentication(this.webauthn.originOf(request), { purpose: "login" });
  }

  @Post("passkeys/login/finish")
  @HttpCode(HttpStatus.OK)
  async loginFinish(
    @Body(new ZodValidationPipe(finishSchema)) body: FinishRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ username: string }> {
    const ipKey = loginIpKey(clientIp(request));
    await refuseThrottled(this.limiter, [ipKey], response);
    try {
      const row = await this.webauthn.claim(body.ceremony, "login");
      if (row === null || row.purpose !== "login") throw new UnauthorizedException(PASSKEY_REJECTED);
      const passkey = await this.webauthn.verifyAuthentication(row, body.response as unknown as AuthenticationResponseJSON);
      const member = await this.tenancy.memberById(passkey.memberId);
      if (member === null) throw new UnauthorizedException(PASSKEY_REJECTED);
      const sessionId = await this.sessions.issue(response, request, member, "passkey", { stepUp: true });
      await this.audit.record("login_succeeded", { memberId: member.id, sessionId, reason: "passkey", request });
      return { username: member.username };
    } catch (error: unknown) {
      if (!(error instanceof UnauthorizedException)) throw error;
      await this.limiter.recordFailure([ipKey]);
      await this.audit.record("login_failed", { reason: "passkey", request });
      throw new UnauthorizedException(PASSKEY_REJECTED);
    }
  }

  // -------------------------------------------------------------------------
  // Register: first passkey of a restricted session (enrol) or another one (add, step-up)
  // -------------------------------------------------------------------------

  @Post("passkeys/register/begin")
  @UseGuards(AuthGuard)
  @RequireScope()
  @AllowRestricted()
  @HttpCode(HttpStatus.OK)
  async registerBegin(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(registerBeginSchema)) _body: RegisterBeginRequest,
    @Req() request: Request,
  ): Promise<Ceremony<PublicKeyCredentialCreationOptionsJSON>> {
    const member = memberOf(principal);
    // A restricted member has no passkey to confirm with; adding one more does.
    if (!member.restricted) assertStepUp(member);
    const target = this.webauthn.originOf(request);
    return this.webauthn.beginRegistration(target, {
      purpose: member.restricted ? "enrol" : "add",
      userHandle: await this.webauthn.ensureUserHandle(member.memberId),
      username: member.username,
      memberId: member.memberId,
      sessionId: Number(member.sessionId),
    });
  }

  @Post("passkeys/register/finish")
  @UseGuards(AuthGuard)
  @RequireScope()
  @AllowRestricted()
  @HttpCode(HttpStatus.OK)
  async registerFinish(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(registerFinishSchema)) body: RegisterFinishRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ passkey: PasskeyView; recovery_codes: string[] | null }> {
    const member = memberOf(principal);
    const sessionId = Number(member.sessionId);
    const row = await this.webauthn.claim(body.ceremony, "register");
    if (
      row === null ||
      row.memberId !== member.memberId ||
      row.sessionId !== sessionId ||
      (row.purpose !== "enrol" && row.purpose !== "add")
    ) {
      throw new UnauthorizedException(PASSKEY_REJECTED);
    }
    const verified = await this.webauthn.verifyRegistration(row, body.response as unknown as RegistrationResponseJSON);

    if (row.purpose === "enrol") {
      const result = await this.enrolment.complete({
        memberId: member.memberId,
        verified,
        name: body.name,
        method: "passkey",
        currentSession: { id: sessionId, authMethod: member.authMethod },
        request,
        response,
      });
      return { passkey: await this.view(member.memberId, result.passkey.id), recovery_codes: result.recoveryCodes };
    }

    // add: still needs a fresh step-up at finish time.
    assertStepUp(member);
    const passkey = await this.webauthn.storePasskey(member.memberId, verified, body.name);
    await this.credentialAudit.record("passkey_added", {
      memberId: member.memberId,
      actorMemberId: member.memberId,
      sessionId,
      passkeyId: passkey.id,
      detail: `${passkey.name} @ ${passkey.rpId}`,
      request,
    });
    return { passkey: await this.view(member.memberId, passkey.id), recovery_codes: null };
  }

  private async view(memberId: number, passkeyId: number): Promise<PasskeyView> {
    const found = (await this.webauthn.list(memberId)).find((p) => p.id === passkeyId);
    if (found === undefined) throw new NotFoundException(`Passkey ${passkeyId} not found`);
    return found;
  }

  // -------------------------------------------------------------------------
  // Management (own passkeys only)
  // -------------------------------------------------------------------------

  @Get("passkeys")
  @UseGuards(AuthGuard)
  @RequireScope()
  list(@CurrentPrincipal() principal: Principal): Promise<PasskeyView[]> {
    return this.webauthn.list(memberOf(principal).memberId);
  }

  @Patch("passkeys/:id")
  @UseGuards(AuthGuard)
  @RequireScope()
  @RequireStepUp()
  async rename(
    @CurrentPrincipal() principal: Principal,
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(renameSchema)) body: RenameRequest,
    @Req() request: Request,
  ): Promise<PasskeyView> {
    const member = memberOf(principal);
    const renamed = await this.webauthn.rename(member.memberId, id, body.name);
    if (renamed === null) throw new NotFoundException(`Passkey ${id} not found`);
    await this.credentialAudit.record("passkey_renamed", {
      memberId: member.memberId,
      actorMemberId: member.memberId,
      sessionId: Number(member.sessionId),
      passkeyId: id,
      detail: renamed.name,
      request,
    });
    return this.view(member.memberId, id);
  }

  @Delete("passkeys/:id")
  @UseGuards(AuthGuard)
  @RequireScope()
  @RequireStepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentPrincipal() principal: Principal,
    @Param("id", ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<void> {
    const member = memberOf(principal);
    const removed = await this.webauthn.remove(member.memberId, id);
    if (removed === "missing") throw new NotFoundException(`Passkey ${id} not found`);
    if (removed === "last") throw new ConflictException("Der letzte Passkey kann nicht entfernt werden");
    await this.credentialAudit.record("passkey_removed", {
      memberId: member.memberId,
      actorMemberId: member.memberId,
      sessionId: Number(member.sessionId),
      passkeyId: id,
      detail: `${removed.name} @ ${removed.rpId}`,
      request,
    });
  }

  // -------------------------------------------------------------------------
  // Step-up: confirm with one of the caller's own passkeys
  // -------------------------------------------------------------------------

  @Post("step-up/begin")
  @UseGuards(AuthGuard)
  @RequireScope()
  @HttpCode(HttpStatus.OK)
  async stepUpBegin(
    @CurrentPrincipal() principal: Principal,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Ceremony<PublicKeyCredentialRequestOptionsJSON>> {
    const member = memberOf(principal);
    await refuseThrottled(this.limiter, [loginIpKey(clientIp(request))], response);
    const target = this.webauthn.originOf(request);
    const started = await this.webauthn.beginAuthentication(target, {
      purpose: "step_up",
      memberId: member.memberId,
      sessionId: Number(member.sessionId),
    });
    if ((started.options.allowCredentials ?? []).length === 0) {
      throw new ConflictException("Für diese Adresse ist kein Passkey eingerichtet");
    }
    return started;
  }

  @Post("step-up/finish")
  @UseGuards(AuthGuard)
  @RequireScope()
  @HttpCode(HttpStatus.NO_CONTENT)
  async stepUpFinish(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(finishSchema)) body: FinishRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const member = memberOf(principal);
    const sessionId = Number(member.sessionId);
    const ipKey = loginIpKey(clientIp(request));
    await refuseThrottled(this.limiter, [ipKey], response);
    try {
      const row = await this.webauthn.claim(body.ceremony, "step_up");
      if (row === null || row.memberId !== member.memberId || row.sessionId !== sessionId) {
        throw new UnauthorizedException(PASSKEY_REJECTED);
      }
      const passkey = await this.webauthn.verifyAuthentication(row, body.response as unknown as AuthenticationResponseJSON);
      if (passkey.memberId !== member.memberId) {
        logger.warn("step_up_foreign_passkey", { member_id: member.memberId, passkey_member_id: passkey.memberId });
        throw new UnauthorizedException(PASSKEY_REJECTED);
      }
      if (!(await this.sessions.markStepUp(sessionId))) throw new UnauthorizedException(PASSKEY_REJECTED);
      await this.credentialAudit.record("step_up_succeeded", {
        memberId: member.memberId,
        sessionId,
        passkeyId: passkey.id,
        request,
      });
    } catch (error: unknown) {
      if (!(error instanceof UnauthorizedException)) throw error;
      await this.limiter.recordFailure([ipKey]);
      await this.credentialAudit.record("step_up_failed", { memberId: member.memberId, sessionId, request });
      throw new UnauthorizedException(PASSKEY_REJECTED);
    }
  }

  // -------------------------------------------------------------------------
  // Recovery codes
  // -------------------------------------------------------------------------

  /** Username + one unused code → a session restricted to enrolling a passkey. */
  @Post("recovery")
  @HttpCode(HttpStatus.OK)
  async recover(
    @Body(new ZodValidationPipe(recoverySchema)) body: RecoveryRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ username: string; enrolment_required: true }> {
    const attempted = body.username.trim().toLowerCase();
    const userKey = loginUserKey(body.username);
    const ipKey = loginIpKey(clientIp(request));
    const retryAfter = await this.limiter.retryAfterSeconds([userKey, ipKey]);
    if (retryAfter !== null) {
      response.setHeader("Retry-After", String(retryAfter));
      await this.audit.record("login_throttled", { username: attempted, reason: "recovery", request });
      throw new HttpException(THROTTLED, HttpStatus.TOO_MANY_REQUESTS);
    }
    const user = await this.authService.findByUsername(body.username.trim());
    const member = user === null ? null : await this.tenancy.resolveMember(user.id);
    // Unknown names run the same claim against nobody (no timing / answer oracle).
    const claimed = await this.recovery.claim(member?.id ?? null, body.code);
    if (!claimed || member === null || user === null) {
      await this.limiter.recordFailure([userKey, ipKey]);
      await this.audit.record("login_failed", { username: attempted, reason: "recovery", request });
      throw new UnauthorizedException(RECOVERY_REJECTED);
    }
    const sessionId = await this.sessions.issue(response, request, member, "recovery");
    await this.limiter.reset(userKey);
    await this.credentialAudit.record("recovery_code_used", { memberId: member.id, sessionId, request });
    await this.audit.record("login_succeeded", { memberId: member.id, sessionId, reason: "recovery", request });
    return { username: user.username, enrolment_required: true };
  }

  @Get("recovery-codes")
  @UseGuards(AuthGuard)
  @RequireScope()
  async recoveryStatus(@CurrentPrincipal() principal: Principal): Promise<{ remaining: number }> {
    return { remaining: await this.recovery.remaining(memberOf(principal).memberId) };
  }

  @Post("recovery-codes")
  @UseGuards(AuthGuard)
  @RequireScope()
  @RequireStepUp()
  @HttpCode(HttpStatus.OK)
  async regenerate(@CurrentPrincipal() principal: Principal, @Req() request: Request): Promise<{ codes: string[] }> {
    const member = memberOf(principal);
    const codes = await this.recovery.generate(member.memberId);
    await this.credentialAudit.record("recovery_codes_generated", {
      memberId: member.memberId,
      actorMemberId: member.memberId,
      sessionId: Number(member.sessionId),
      request,
    });
    return { codes };
  }
}
