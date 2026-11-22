import { logger } from "@aktenraum/core";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";

import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { AuthAuditService } from "./auth-audit.service.js";
import { AuthGuard } from "./auth.guard.js";
import { loginRequestSchema, type LoginRequest, type UserResponse } from "./auth.schemas.js";
import { AuthService } from "./auth.service.js";
import { AllowRestricted, AllowToken, CurrentPrincipal, RequireScope, type MemberPrincipal, type Principal } from "./principal.js";
import { AuthRateLimiter, loginIpKey, loginUserKey } from "./rate-limiter.js";
import { SessionService, clientIp, type SessionListEntry } from "./session.service.js";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessions: SessionService,
    private readonly limiter: AuthRateLimiter,
    private readonly audit: AuthAuditService,
  ) {}

  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UserResponse> {
    const userKey = loginUserKey(body.username);
    const ipKey = loginIpKey(clientIp(request));
    const attempted = body.username.trim().toLowerCase();
    const retryAfter = await this.limiter.retryAfterSeconds([userKey, ipKey]);
    if (retryAfter !== null) {
      response.setHeader("Retry-After", String(retryAfter));
      logger.warn("login_throttled", { username: attempted, ip: request.ip, retry_after: retryAfter });
      await this.audit.record("login_throttled", { username: attempted, request });
      throw new HttpException(
        "Zu viele fehlgeschlagene Anmeldeversuche. Bitte später erneut versuchen.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const user = await this.authService.authenticate(body.username, body.password);
    const issued = user === null ? null : await this.authService.issueSession(response, request, user, "password");
    if (user === null || issued === null) {
      await this.limiter.recordFailure([userKey, ipKey]);
      await this.audit.record("login_failed", { username: attempted, request });
      throw new UnauthorizedException("Invalid credentials");
    }
    // Only the account's count resets: an address that sprayed stays limited.
    await this.limiter.reset(userKey);
    await this.audit.record("login_succeeded", { memberId: issued.memberId, sessionId: issued.sessionId, request });
    return { username: user.username, enrolment_required: true };
  }

  /** Unguarded: an unknown or expired cookie is a no-op that still clears it. */
  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<void> {
    const token = this.sessions.readToken(request);
    const session = token === null ? null : await this.sessions.findActiveByToken(token);
    if (session !== null && (await this.sessions.revoke(session.sessionId, "logout"))) {
      await this.audit.record("logout", { memberId: session.memberId, sessionId: session.sessionId, request });
    }
    this.sessions.clearCookies(response);
  }

  /**
   * Allowed for restricted sessions (the SPA learns from it that enrolment is
   * due) and for personal access tokens (a script checks who it is).
   */
  @Get("me")
  @UseGuards(AuthGuard)
  @RequireScope()
  @AllowRestricted()
  @AllowToken()
  me(@CurrentPrincipal() principal: Principal): UserResponse {
    const member = memberOf(principal);
    return {
      username: member.username,
      household_role: member.householdRole,
      enrolment_required: member.restricted,
      auth_method: member.authMethod,
      ...(member.token ? { token_name: member.token.name } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Device list: the caller's own sessions only.
  // -------------------------------------------------------------------------

  @Get("sessions")
  @UseGuards(AuthGuard)
  @RequireScope()
  listSessions(@CurrentPrincipal() principal: Principal): Promise<SessionListEntry[]> {
    const member = memberOf(principal);
    return this.sessions.listActive(member.memberId, sessionIdOf(member));
  }

  @Post("sessions/revoke-others")
  @UseGuards(AuthGuard)
  @RequireScope()
  @HttpCode(HttpStatus.OK)
  async revokeOtherSessions(
    @CurrentPrincipal() principal: Principal,
    @Req() request: Request,
  ): Promise<{ revoked: number }> {
    const member = memberOf(principal);
    const current = sessionIdOf(member);
    if (current === null) throw new UnauthorizedException("Not authenticated");
    const revoked = await this.sessions.revokeOthers(member.memberId, current, "other_device");
    await this.audit.recordRevocations(revoked, {
      memberId: member.memberId,
      actorMemberId: member.memberId,
      reason: "other_device",
      request,
    });
    return { revoked: revoked.length };
  }

  @Delete("sessions/:id")
  @UseGuards(AuthGuard)
  @RequireScope()
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeSession(
    @Param("id", ParseIntPipe) id: number,
    @CurrentPrincipal() principal: Principal,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const member = memberOf(principal);
    const isCurrent = id === sessionIdOf(member);
    const reason = isCurrent ? "user" : "other_device";
    if (!(await this.sessions.revokeOwn(member.memberId, id, reason))) {
      // Someone else's, unknown, or already ended: indistinguishable.
      throw new NotFoundException(`Session ${id} not found`);
    }
    await this.audit.recordRevocations([id], { memberId: member.memberId, actorMemberId: member.memberId, reason, request });
    if (isCurrent) this.sessions.clearCookies(response);
  }
}

/** AuthGuard only ever produces member principals; this narrows the type. */
function memberOf(principal: Principal): MemberPrincipal {
  if (principal.kind !== "member") throw new UnauthorizedException("Not authenticated");
  return principal;
}

function sessionIdOf(member: MemberPrincipal): number | null {
  return member.sessionId === null ? null : Number(member.sessionId);
}
